import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeMergeCount,
  buildActionLog,
  buildOperationDetailModel,
  buildOperationGraph,
  filterDependabotGroups,
  githubQueueSummary,
  isActiveMergeOperation,
  PHASES,
  queueSummary,
  repoDomId,
  retrySummary,
  sortMergeOperations,
  STRATEGIES,
  totalPrs,
} from "../src/js/dependabot-model.js";

/* Pure model logic — no DOM. Covers the repo-refine + recency-sort pipeline and the small
 * helpers the view relies on. */

function group(fullName, prs) {
  return { full_name: fullName, total: prs.length, prs };
}
function pr(id, updated_at) {
  return {
    id,
    number: id,
    title: `PR ${id}`,
    html_url: `https://x/${id}`,
    author: "dependabot[bot]",
    updated_at,
  };
}

const groups = [
  group("octo/a", [pr(1, "2026-01-01T00:00:00Z"), pr(2, "2026-01-03T00:00:00Z")]),
  group("octo/b", [pr(3, "2026-01-02T00:00:00Z")]),
];

test("filterDependabotGroups orders repos by most recent PR, newest first", () => {
  const out = filterDependabotGroups(groups, null);
  // octo/a has a PR updated 01-03 (newest) → it sorts ahead of octo/b (01-02).
  assert.deepEqual(
    out.map((g) => g.full_name),
    ["octo/a", "octo/b"],
  );
});

test("filterDependabotGroups narrows to a single repo when refined", () => {
  const out = filterDependabotGroups(groups, "octo/b");
  assert.equal(out.length, 1);
  assert.equal(out[0].full_name, "octo/b");
});

test("filterDependabotGroups with an unknown repo yields nothing", () => {
  assert.deepEqual(filterDependabotGroups(groups, "octo/missing"), []);
});

test("filterDependabotGroups does not mutate the input", () => {
  const snapshot = JSON.stringify(groups);
  filterDependabotGroups(groups, "octo/a");
  assert.equal(JSON.stringify(groups), snapshot);
});

test("totalPrs sums PRs across groups", () => {
  assert.equal(totalPrs(groups), 3);
  assert.equal(totalPrs([]), 0);
});

test("repoDomId produces a DOM-safe id from a full_name", () => {
  assert.equal(repoDomId("octo/hello"), "dep-repo-octo-hello");
  assert.equal(repoDomId("acme/my.widget_v2"), "dep-repo-acme-my-widget-v2");
});

test("merge operations sort active FIFO before newest terminal history", () => {
  const operations = [
    { id: 1, state: "merged", enqueued_at: "2026-01-01", terminal_at: "2026-01-03" },
    { id: 2, state: "queued", enqueued_at: "2026-01-02" },
    { id: 3, state: "failed", enqueued_at: "2026-01-01", terminal_at: "2026-01-04" },
    { id: 4, state: "delegated", enqueued_at: "2026-01-01" },
  ];
  assert.deepEqual(
    sortMergeOperations(operations).map((operation) => operation.id),
    [4, 2, 3, 1],
  );
  assert.equal(activeMergeCount(operations), 2);
  assert.equal(isActiveMergeOperation(operations[0]), false);
});

/* ---------------------------------------------------------------------------------------
 * Phase 2: buildOperationGraph, buildActionLog, and buildOperationDetailModel.
 * --------------------------------------------------------------------------------------- */

function nodeById(graph, id) {
  return graph.nodes.find((n) => n.id === id);
}

test("buildOperationGraph (direct strategy): steps before the current phase are done", () => {
  const graph = buildOperationGraph({
    state: "delegated",
    phase: PHASES.MERGING,
    strategy: STRATEGIES.DIRECT,
    retry_count: 0,
  });
  assert.equal(graph.strategy, "direct");
  assert.equal(nodeById(graph, "queued").state, "done");
  assert.equal(nodeById(graph, "validating").state, "done");
  assert.equal(nodeById(graph, "approving").state, "done");
  assert.equal(nodeById(graph, "updating_branch").state, "done");
  assert.equal(nodeById(graph, "waiting_checks").state, "done");
  // No retry ever happened, so the (unused) retry pair is "skipped", not "done".
  assert.equal(nodeById(graph, "retry_scheduled").state, "skipped");
  assert.equal(nodeById(graph, "retrying_checks").state, "skipped");
  assert.equal(nodeById(graph, "merging").state, "current");
  assert.equal(nodeById(graph, "terminal").state, "upcoming");
  // Only the direct-branch node is present, no merge-queue-only steps.
  assert.equal(
    graph.nodes.some((n) => n.id === "enabling_auto_merge" || n.id === "waiting_merge_queue"),
    false,
  );
});

test("buildOperationGraph (direct strategy): every shared phase maps to a node", () => {
  for (const phase of [
    PHASES.QUEUED,
    PHASES.VALIDATING,
    PHASES.APPROVING,
    PHASES.UPDATING_BRANCH,
    PHASES.WAITING_CHECKS,
  ]) {
    const graph = buildOperationGraph({ state: "queued", phase, strategy: STRATEGIES.DIRECT });
    const node = nodeById(graph, phase);
    assert.ok(node, `expected a node for phase ${phase}`);
    assert.equal(node.state, "current");
  }
});

test("buildOperationGraph: an actual retry marks the retry pair done, not skipped", () => {
  const graph = buildOperationGraph({
    state: "delegated",
    phase: PHASES.RETRYING_CHECKS,
    strategy: STRATEGIES.DIRECT,
    retry_count: 2,
    max_retries: 5,
  });
  assert.equal(nodeById(graph, "retry_scheduled").state, "done");
  assert.equal(nodeById(graph, "retrying_checks").state, "current");
  assert.equal(nodeById(graph, "retrying_checks").detail, "Retry 2 of 5");
  assert.equal(nodeById(graph, "merging").state, "upcoming");
});

test("buildOperationGraph (merge_queue strategy): covers enabling auto-merge and waiting in queue", () => {
  const graph = buildOperationGraph({
    state: "delegated",
    phase: PHASES.WAITING_MERGE_QUEUE,
    strategy: STRATEGIES.MERGE_QUEUE,
    merge_queue_position: 3,
  });
  assert.equal(graph.strategy, "merge_queue");
  assert.equal(nodeById(graph, "enabling_auto_merge").state, "done");
  assert.equal(nodeById(graph, "waiting_merge_queue").state, "current");
  assert.equal(nodeById(graph, "waiting_merge_queue").detail, "GitHub queue position 3");
  assert.equal(nodeById(graph, "merging").state, "upcoming");
  assert.equal(nodeById(graph, "terminal").state, "upcoming");
});

test("buildOperationGraph (merge_queue strategy): every branch phase maps to a node", () => {
  for (const phase of [PHASES.ENABLING_AUTO_MERGE, PHASES.WAITING_MERGE_QUEUE, PHASES.MERGING]) {
    const graph = buildOperationGraph({
      state: "delegated",
      phase,
      strategy: STRATEGIES.MERGE_QUEUE,
    });
    assert.equal(nodeById(graph, phase).state, "current");
  }
});

test("buildOperationGraph (unknown strategy): shows strategy-detection + both branches as upcoming, safely", () => {
  const graph = buildOperationGraph({ state: "validating", phase: PHASES.APPROVING });
  assert.equal(graph.strategy, "unknown");
  assert.equal(nodeById(graph, "approving").state, "current");
  assert.equal(nodeById(graph, "strategy_detection").state, "upcoming");
  assert.equal(nodeById(graph, "direct:merging").state, "upcoming");
  assert.equal(nodeById(graph, "queue:enabling_auto_merge").state, "upcoming");
  assert.equal(nodeById(graph, "queue:waiting_merge_queue").state, "upcoming");
  assert.equal(nodeById(graph, "queue:merging").state, "upcoming");
  assert.equal(nodeById(graph, "terminal").state, "upcoming");
});

test("buildOperationGraph (unknown strategy): terminating before it resolves skips both branches", () => {
  const graph = buildOperationGraph({
    state: "failed",
    phase: PHASES.VALIDATING,
    failure_reason: "boom",
  });
  assert.equal(nodeById(graph, "validating").state, "failed");
  assert.equal(nodeById(graph, "approving").state, "skipped");
  assert.equal(nodeById(graph, "strategy_detection").state, "skipped");
  assert.equal(nodeById(graph, "direct:merging").state, "skipped");
  assert.equal(nodeById(graph, "queue:waiting_merge_queue").state, "skipped");
  assert.equal(nodeById(graph, "terminal").state, "failed");
});

test("buildOperationGraph: an unrecognized phase/strategy doesn't throw and stays safe", () => {
  assert.doesNotThrow(() => buildOperationGraph({}));
  const graph = buildOperationGraph({
    state: "queued",
    phase: "totally-unknown",
    strategy: "nope",
  });
  assert.equal(graph.strategy, "nope");
  assert.equal(nodeById(graph, "queued").state, "current");
});

test("buildOperationGraph: terminal phases — merged/failed/cancelled/timed_out map correctly", () => {
  const merged = buildOperationGraph({
    state: "merged",
    phase: PHASES.MERGING,
    strategy: STRATEGIES.DIRECT,
  });
  assert.equal(nodeById(merged, "terminal").state, "done");
  assert.equal(nodeById(merged, "terminal").label, "Merged");
  // Every prior step on the (taken) direct path reads "done".
  assert.equal(nodeById(merged, "merging").state, "done");

  for (const [state, label] of [
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["timed_out", "Timed out"],
  ]) {
    const graph = buildOperationGraph({
      state,
      phase: PHASES.WAITING_CHECKS,
      strategy: STRATEGIES.DIRECT,
    });
    assert.equal(nodeById(graph, "terminal").state, "failed");
    assert.equal(nodeById(graph, "terminal").label, label);
    assert.equal(nodeById(graph, "waiting_checks").state, "failed");
    // Steps never reached before the failure are "skipped", not "done".
    assert.equal(nodeById(graph, "merging").state, "skipped");
  }
});

test("buildOperationGraph: terminal node folds in the failure reason as its detail", () => {
  const graph = buildOperationGraph({
    state: "failed",
    phase: PHASES.MERGING,
    strategy: STRATEGIES.DIRECT,
    failure_reason: "merge conflict",
  });
  assert.equal(nodeById(graph, "terminal").detail, "merge conflict");
});

test("retrySummary / queueSummary render one-liners, or null when not applicable", () => {
  assert.equal(retrySummary({ retry_count: 0 }), null);
  assert.equal(retrySummary({ retry_count: 2 }), "Retry 2");
  assert.equal(retrySummary({ retry_count: 2, max_retries: 5 }), "Retry 2 of 5");
  assert.equal(queueSummary({}), null);
  assert.equal(queueSummary({ queue_position: 4 }), "Queue position 4");
});

test("buildActionLog orders events oldest-first by timestamp", () => {
  const log = buildActionLog([
    { timestamp: "2026-01-03T00:00:00Z", message: "third" },
    { timestamp: "2026-01-01T00:00:00Z", message: "first" },
    { timestamp: "2026-01-02T00:00:00Z", message: "second" },
  ]);
  assert.deepEqual(
    log.map((e) => e.message),
    ["first", "second", "third"],
  );
});

test("buildActionLog falls back to original array order for missing/unparseable timestamps", () => {
  const log = buildActionLog([
    { message: "no timestamp at all" },
    { timestamp: "2026-01-01T00:00:00Z", message: "has a timestamp" },
    { timestamp: "not-a-date", message: "unparseable" },
  ]);
  // Events with a valid timestamp sort ahead of those without one.
  assert.equal(log[0].message, "has a timestamp");
  assert.deepEqual(
    log.slice(1).map((e) => e.message),
    ["no timestamp at all", "unparseable"],
  );
});

test("buildActionLog normalizes fields and tolerates a missing/non-array input", () => {
  assert.deepEqual(buildActionLog(undefined), []);
  assert.deepEqual(buildActionLog(null), []);
  const [event] = buildActionLog([{ id: "e1", at: "2026-01-01T00:00:00Z", description: "hi" }]);
  assert.equal(event.id, "e1");
  assert.equal(event.timestamp, "2026-01-01T00:00:00Z");
  assert.equal(event.message, "hi");
});

test("buildActionLog maps backend event fields to visible activity text", () => {
  const [event] = buildActionLog([
    {
      id: 7,
      summary: "Resolved a direct-merge strategy.",
      created_at: "2026-01-01T00:00:00Z",
    },
  ]);
  assert.equal(event.message, "Resolved a direct-merge strategy.");
  assert.equal(event.timestamp, "2026-01-01T00:00:00Z");
});

test("buildOperationDetailModel assembles the graph, action log, explanations, and retry/queue summaries", () => {
  const model = buildOperationDetailModel({
    operation: {
      state: "delegated",
      phase: PHASES.WAITING_MERGE_QUEUE,
      strategy: STRATEGIES.MERGE_QUEUE,
      merge_queue_position: 2,
    },
    events: [{ timestamp: "2026-01-01T00:00:00Z", message: "Queued for merge" }],
    current_explanation: "Waiting for the merge queue to pick this PR up.",
    next_action: "No action needed — Helix will merge automatically.",
  });
  assert.equal(model.graph.strategy, "merge_queue");
  assert.equal(model.actionLog.length, 1);
  assert.equal(model.currentExplanation, "Waiting for the merge queue to pick this PR up.");
  assert.equal(model.nextAction, "No action needed — Helix will merge automatically.");
  assert.equal(model.queue, null);
  assert.equal(model.githubQueue, "GitHub queue position 2");
  assert.equal(model.retry, null);
});

test("buildOperationDetailModel tolerates a missing operation/events", () => {
  const model = buildOperationDetailModel({});
  assert.equal(model.graph.strategy, "unknown");
  assert.deepEqual(model.actionLog, []);
  assert.equal(model.currentExplanation, "");
  assert.equal(model.nextAction, "");
});

/* ---------------------------------------------------------------------------------------
 * Backend field-name fixes: the real `DependabotMergeOperation` (see `src-tauri/src/
 * dependabot.rs`) uses `check_retry_count` for the retry counter, `queue_position` for
 * Helix's own repo-scoped FIFO position, and `merge_queue_position` for GitHub's native
 * merge-queue position — three distinct fields the model must not conflate.
 * --------------------------------------------------------------------------------------- */

test("retrySummary/hasRetried prefer the backend's check_retry_count field", () => {
  assert.equal(retrySummary({ check_retry_count: 0 }), null);
  assert.equal(retrySummary({ check_retry_count: 3 }), "Retry 3");
  // A synthetic/legacy `retry_count`/`retries` still works as a fallback.
  assert.equal(retrySummary({ retry_count: 2 }), "Retry 2");
  assert.equal(retrySummary({ retries: 1 }), "Retry 1");
  // check_retry_count wins when both are present.
  assert.equal(retrySummary({ check_retry_count: 5, retry_count: 1 }), "Retry 5");

  const graph = buildOperationGraph({
    state: "delegated",
    phase: PHASES.RETRYING_CHECKS,
    strategy: STRATEGIES.DIRECT,
    check_retry_count: 1,
  });
  assert.equal(nodeById(graph, "retry_scheduled").state, "done");
  assert.equal(nodeById(graph, "retrying_checks").detail, "Retry 1");
});

test("queueSummary (Helix FIFO) and githubQueueSummary (GitHub merge queue) stay distinct", () => {
  assert.equal(queueSummary({ queue_position: 2 }), "Queue position 2");
  assert.equal(queueSummary({ merge_queue_position: 2 }), null);
  assert.equal(githubQueueSummary({ merge_queue_position: 4 }), "GitHub queue position 4");
  assert.equal(githubQueueSummary({ queue_position: 4 }), null);

  // Both can be present at once (e.g. Helix's FIFO position while GitHub's merge queue also
  // reports one) without either clobbering the other.
  const operation = { queue_position: 1, merge_queue_position: 5 };
  assert.equal(queueSummary(operation), "Queue position 1");
  assert.equal(githubQueueSummary(operation), "GitHub queue position 5");
});

test("buildOperationGraph surfaces Helix's own queue_position on the shared 'queued' step", () => {
  const graph = buildOperationGraph({ state: "queued", phase: PHASES.QUEUED, queue_position: 2 });
  assert.equal(nodeById(graph, "queued").detail, "Queue position 2");
  // The merge-queue-only GitHub position must not leak onto the shared "queued" step.
  const other = buildOperationGraph({
    state: "queued",
    phase: PHASES.QUEUED,
    merge_queue_position: 9,
  });
  assert.equal(nodeById(other, "queued").detail, "");
});
