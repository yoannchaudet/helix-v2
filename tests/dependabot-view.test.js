import { test } from "node:test";
import assert from "node:assert/strict";

import {
  operationActionLog,
  operationDetailPanel,
  operationDetailPanelId,
  operationFlow,
  operationRow,
  operationsList,
  prRow,
  repoHeader,
  repoSection,
} from "../src/js/dependabot-view.js";
import { buildOperationGraph, PHASES, STRATEGIES } from "../src/js/dependabot-model.js";

/* These render pure HTML strings, so they're unit-testable without a DOM. The most important
 * properties: every interpolated field (which is untrusted GitHub data) is HTML-escaped, the
 * merge-readiness pill maps correctly, and the read-only rows carry NO bookmark/done affordances. */

const basePr = {
  id: 101,
  number: 40,
  title: "Bump lodash",
  html_url: "https://github.com/octo/hello/pull/40",
  author: "dependabot[bot]",
  base_ref: "main",
  updated_at: "2026-01-01T00:00:00Z",
  mergeable_state: "clean",
};

test("prRow renders an openable row with the PR number, url, and PR badge", () => {
  const row = prRow(basePr);
  assert.ok(row.includes("n-row--openable"));
  assert.ok(row.includes('data-pr-id="101"'));
  assert.ok(row.includes('data-url="https://github.com/octo/hello/pull/40"'));
  assert.ok(row.includes('role="link"'));
  assert.ok(row.includes("#40"));
  assert.ok(row.includes("badge--pr"));
});

test("prRow shows the merge-readiness pill for the mergeable_state", () => {
  assert.ok(prRow({ ...basePr, mergeable_state: "clean" }).includes("merge--clean"));
  assert.ok(prRow({ ...basePr, mergeable_state: "blocked" }).includes("merge--blocked"));
  // unknown/null → no pill (GitHub computes it lazily).
  assert.ok(!prRow({ ...basePr, mergeable_state: null }).includes("n-state"));
  assert.ok(!prRow({ ...basePr, mergeable_state: "unknown" }).includes("n-state"));
});

test("prRow shows and escapes the target branch, but tolerates legacy rows", () => {
  assert.ok(prRow(basePr).includes("Target: main"));
  assert.ok(prRow({ ...basePr, base_ref: "<release&next>" }).includes("&lt;release&amp;next&gt;"));
  assert.ok(!prRow({ ...basePr, base_ref: null }).includes("Target:"));
});

test("prRow marks a bot author and drops the [bot] suffix", () => {
  const row = prRow(basePr);
  assert.ok(row.includes("n-author--bot"));
  assert.ok(row.includes("dependabot"));
  assert.ok(!row.includes("dependabot[bot]</span>"));
});

test("prRow escapes untrusted fields", () => {
  const row = prRow({ ...basePr, title: "<img src=x onerror=alert(1)>" });
  assert.ok(!row.includes("<img src=x"));
  assert.ok(row.includes("&lt;img"));
});

test("prRow has a merge affordance but no notification-only controls", () => {
  const row = prRow(basePr);
  assert.ok(!row.includes("n-bookmark"));
  assert.ok(!row.includes("n-done"));
  assert.ok(row.includes("dep-merge-action"));
  assert.ok(row.includes("dep-discard-action"));
  assert.ok(row.includes('data-pr-id="101"'));
});

test("repoHeader shows the repo name, its PR count, and no mark-done control", () => {
  const header = repoHeader({ full_name: "octo/hello", prs: [basePr, { ...basePr, id: 2 }] });
  assert.ok(header.includes("octo/hello"));
  assert.ok(header.includes('class="repo-counts">2<'));
  assert.ok(!header.includes("repo-done"));
});

test("repoSection wraps rows in a labeled group tied to its heading", () => {
  const section = repoSection({ full_name: "octo/hello", prs: [basePr] });
  assert.ok(section.includes('role="group"'));
  assert.ok(section.includes('aria-labelledby="dep-repo-octo-hello"'));
  assert.ok(section.includes('id="dep-repo-octo-hello"'));
  assert.ok(section.includes("n-list"));
});

const baseOperation = {
  id: 7,
  pr_id: 101,
  repo_full_name: "octo/hello",
  number: 40,
  title: "Bump lodash",
  html_url: "https://github.com/octo/hello/pull/40",
  base_ref: "main",
  state: "queued",
  queue_position: 2,
  enqueued_at: "2026-01-01T00:00:00Z",
};

test("operationRow renders queue state, position, and cancellation", () => {
  const row = operationRow(baseOperation);
  assert.ok(row.includes("Queued"));
  assert.ok(row.includes("queue 2"));
  assert.ok(row.includes("dep-operation-cancel"));
  assert.ok(row.includes("dep-discard-action--operation"));
  assert.ok(row.includes('data-operation-id="7"'));
  assert.ok(row.includes("Target: main"));
});

test("operationRow escapes the target branch and tolerates legacy operations", () => {
  assert.ok(
    operationRow({ ...baseOperation, base_ref: "<release&next>" }).includes(
      "&lt;release&amp;next&gt;",
    ),
  );
  assert.ok(!operationRow({ ...baseOperation, base_ref: null }).includes("Target:"));
});

test("terminal operations render errors without a cancellation action", () => {
  const row = operationRow({
    ...baseOperation,
    state: "failed",
    failure_reason: "<conflict>",
    terminal_at: "2026-01-02T00:00:00Z",
  });
  assert.ok(row.includes("Failed"));
  assert.ok(row.includes("&lt;conflict&gt;"));
  assert.ok(row.includes('class="operation-detail operation-detail--error"'));
  assert.ok(!row.includes("dep-operation-cancel"));
  assert.ok(!row.includes("dep-discard-action"));
});

test("merged operations render terminal detail with neutral styling", () => {
  const row = operationRow({
    ...baseOperation,
    state: "merged",
    failure_reason: "Merged on GitHub.",
    terminal_at: "2026-01-02T00:00:00Z",
  });
  assert.ok(row.includes("Merged on GitHub."));
  assert.ok(row.includes('class="operation-detail"'));
  assert.ok(!row.includes("operation-detail--error"));
});

test("cancelled operations render terminal detail with neutral styling", () => {
  const row = operationRow({
    ...baseOperation,
    state: "cancelled",
    failure_reason: "Cancelled.",
    terminal_at: "2026-01-02T00:00:00Z",
  });
  assert.ok(row.includes("Cancelled."));
  assert.ok(row.includes('class="operation-detail"'));
  assert.ok(!row.includes("operation-detail--error"));
});

test("active operations render explicit last errors with error styling", () => {
  const row = operationRow({
    ...baseOperation,
    state: "delegated",
    last_error: "GitHub request failed.",
  });
  assert.ok(row.includes('class="operation-detail operation-detail--error"'));
});

test("operationsList splits active and recent operations into repository groups", () => {
  const output = operationsList([
    baseOperation,
    {
      ...baseOperation,
      id: 8,
      repo_full_name: "acme/widgets",
      state: "queued",
    },
    {
      ...baseOperation,
      id: 10,
      title: "Bump axios",
      state: "queued",
    },
    {
      ...baseOperation,
      id: 9,
      state: "merged",
      terminal_at: "2026-01-02T00:00:00Z",
    },
  ]);
  assert.ok(output.includes(">Active<"));
  assert.ok(output.includes(">Recent<"));
  assert.ok(output.includes('data-operation-status="active"'));
  assert.ok(output.includes('data-operation-status="recent"'));
  assert.ok(output.includes('data-repo="octo/hello"'));
  assert.ok(output.includes('data-repo="acme/widgets"'));
  assert.equal(output.match(/role="group"/g)?.length, 3);
  assert.equal(output.match(/class="operation-repo-group"/g)?.length, 3);
  assert.ok(output.indexOf("octo/hello") < output.indexOf("acme/widgets"));
  assert.ok(output.indexOf('data-operation-id="7"') < output.indexOf('data-operation-id="10"'));
});

test("operationsList escapes repository group names", () => {
  const output = operationsList([
    { ...baseOperation, repo_full_name: "<img src=x onerror=alert(1)>" },
  ]);
  assert.ok(output.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!output.includes("<img src=x"));
});

/* ---------------------------------------------------------------------------------------
 * Phase 2: the disclosure button, the inline flow visualization, the selected-node readout,
 * and the timestamped action log.
 * --------------------------------------------------------------------------------------- */

test("operationRow always renders an accessible disclosure button, independent of the PR link/cancel button", () => {
  const row = operationRow(baseOperation);
  assert.ok(row.includes("dep-operation-disclosure"));
  assert.ok(row.includes('aria-expanded="false"'));
  assert.ok(row.includes(`aria-controls="${operationDetailPanelId(7)}"`));
  // It's a real, separately-focusable <button>, not nested inside the PR-link `role="link"`
  // container or folded into the cancel control.
  const openDiv = row.slice(row.indexOf('<div class="n-open"'), row.indexOf("</div>"));
  assert.ok(!openDiv.includes("dep-operation-disclosure"));
  assert.ok(!row.match(/dep-operation-cancel[^>]*dep-operation-disclosure/));
});

test("operationRow with no options renders the same compact row as before (no panel markup)", () => {
  const row = operationRow(baseOperation);
  assert.ok(!row.includes("op-panel-row"));
  assert.ok(!row.includes("op-flow"));
  assert.ok(row.includes("Queued"));
  assert.ok(row.includes("queue 2"));
  assert.ok(row.includes("dep-operation-cancel"));
});

test("operationRow expanded without a detail payload yet renders a loading placeholder", () => {
  const row = operationRow(baseOperation, { expanded: true });
  assert.ok(row.includes("op-panel-row"));
  assert.ok(row.includes("Loading operation timeline"));
  assert.ok(row.includes('aria-expanded="true"'));
  assert.ok(row.includes("is-expanded"));
});

const richOperation = {
  ...baseOperation,
  state: "delegated",
  phase: PHASES.WAITING_MERGE_QUEUE,
  strategy: STRATEGIES.MERGE_QUEUE,
  merge_queue_position: 3,
};

const richDetail = {
  operation: richOperation,
  events: [
    { timestamp: "2026-01-01T00:00:00Z", message: "Merge queued" },
    { timestamp: "2026-01-01T00:05:00Z", message: "Validated <ok>" },
  ],
  current_explanation: "Waiting in the merge queue.",
  next_action: "No action needed.",
};

test("operationRow expanded with a detail payload renders the flow graph, aria-current, and action log", () => {
  const row = operationRow(richOperation, { expanded: true, detail: richDetail });
  assert.ok(row.includes("op-flow"));
  assert.ok(row.includes('aria-current="step"'));
  assert.ok(row.includes("Waiting in the merge queue."));
  assert.ok(row.includes("No action needed."));
  assert.ok(row.includes("GitHub queue position 3"));
  assert.ok(row.includes("Merge queued"));
  // Untrusted event content is escaped.
  assert.ok(row.includes("Validated &lt;ok&gt;"));
  assert.ok(!row.includes("Validated <ok>"));
});

test("operationFlow renders read-only steps with aria-current on the active step", () => {
  const graph = buildOperationGraph({
    state: "delegated",
    phase: PHASES.WAITING_CHECKS,
    strategy: STRATEGIES.DIRECT,
  });
  const flow = operationFlow(graph);
  assert.ok(flow.includes("<ol"));
  assert.ok(/op-step--current"[^>]*aria-current="step"/.test(flow));
  assert.ok(flow.includes('data-node-id="waiting_checks"'));
  assert.ok(!flow.includes("<button"));
  assert.ok(!flow.includes("aria-pressed"));
  assert.ok(!flow.includes("tabindex"));
  // Only one step is current.
  assert.ok(!flow.match(/data-node-id="queued"[^>]*aria-current/));
});

test("operationFlow exposes completed/current/upcoming/skipped/failed state in step labels", () => {
  const flow = operationFlow({
    strategy: STRATEGIES.DIRECT,
    nodes: [
      {
        id: "queued",
        label: "Queued",
        state: "done",
        detail: "Queue position 2",
        group: "prep",
      },
      { id: "validating", label: "Validating", state: "current", detail: "", group: "prep" },
      {
        id: "waiting_checks",
        label: "Waiting on checks",
        state: "upcoming",
        detail: "",
        group: "prep",
      },
      {
        id: "retrying_checks",
        label: "Retrying checks",
        state: "skipped",
        detail: "Retry 1",
        group: "retry",
      },
      {
        id: "terminal",
        label: "Failed",
        state: "failed",
        detail: "Merge conflict",
        group: "terminal",
      },
    ],
  });
  assert.ok(flow.includes('aria-label="Queued, completed. Queue position 2"'));
  assert.ok(flow.includes('aria-label="Validating, current"'));
  assert.ok(flow.includes('aria-label="Waiting on checks, upcoming"'));
  assert.ok(flow.includes('aria-label="Retrying checks, skipped. Retry 1"'));
  assert.ok(flow.includes('aria-label="Failed, failed. Merge conflict"'));
  assert.ok(flow.includes("Queue position 2"));
  assert.ok(flow.includes("Merge conflict"));
});

test("operationFlow marks a branch marker naming the strategy, and only that branch's steps", () => {
  const direct = operationFlow(
    buildOperationGraph({ state: "delegated", phase: PHASES.MERGING, strategy: STRATEGIES.DIRECT }),
  );
  assert.ok(direct.includes("Direct merge"));
  assert.ok(!direct.includes("Merge queue"));

  const queue = operationFlow(
    buildOperationGraph({
      state: "delegated",
      phase: PHASES.ENABLING_AUTO_MERGE,
      strategy: STRATEGIES.MERGE_QUEUE,
    }),
  );
  assert.ok(queue.includes("Merge queue"));
  assert.ok(queue.includes("Waiting in merge queue"));
});

test("operationFlow hides an unresolved strategy marker once an operation is terminal", () => {
  const active = operationFlow(
    buildOperationGraph({ state: "validating", phase: PHASES.VALIDATING }),
  );
  assert.ok(active.includes("Merge strategy not yet determined"));

  for (const state of ["merged", "cancelled", "failed", "timed_out"]) {
    const terminal = operationFlow(buildOperationGraph({ state, phase: PHASES.VALIDATING }));
    assert.ok(!terminal.includes("Merge strategy not yet determined"));
    assert.ok(!terminal.includes("op-flow-marker"));
    assert.ok(terminal.includes('data-node-id="strategy_detection"'));
  }

  const direct = operationFlow(
    buildOperationGraph({
      state: "merged",
      phase: PHASES.MERGING,
      strategy: STRATEGIES.DIRECT,
    }),
  );
  assert.ok(direct.includes("op-flow-marker"));
  assert.ok(direct.includes("Direct merge"));

  const queue = operationFlow(
    buildOperationGraph({
      state: "cancelled",
      phase: PHASES.WAITING_MERGE_QUEUE,
      strategy: STRATEGIES.MERGE_QUEUE,
    }),
  );
  assert.ok(queue.includes("op-flow-marker"));
  assert.ok(queue.includes("Merge queue"));
});

test("operationFlow escapes node labels/details even though they're internal strings", () => {
  const graph = buildOperationGraph({
    state: "failed",
    phase: PHASES.MERGING,
    strategy: STRATEGIES.DIRECT,
    failure_reason: "<script>evil()</script>",
  });
  const flow = operationFlow(graph);
  assert.ok(!flow.includes("<script>evil()"));
});

test("operationActionLog renders a timestamped, ordered, escaped log", () => {
  const log = operationActionLog([
    {
      timestamp: "2026-01-01T00:00:00Z",
      message: "First <b>step</b>",
      detail: "<em>info</em>",
    },
    { timestamp: "2026-01-02T00:00:00Z", message: "Second step" },
  ]);
  const firstIndex = log.indexOf("First");
  const secondIndex = log.indexOf("Second");
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex);
  assert.ok(log.includes("&lt;b&gt;step&lt;/b&gt;"));
  assert.ok(!log.includes("<b>step</b>"));
  assert.ok(log.includes('<span class="op-log-detail">&lt;em&gt;info&lt;/em&gt;</span>'));
  assert.ok(!log.includes("&lt;span class=&quot;op-log-detail&quot;"));
  assert.ok(!log.includes("<em>info</em>"));
  assert.ok(log.includes('datetime="2026-01-01T00:00:00Z"'));
});

test("operationActionLog renders an empty state for no events", () => {
  assert.ok(operationActionLog([]).includes("No actions recorded yet"));
});

test("operationActionLog omits datetime when an event has no timestamp", () => {
  const log = operationActionLog([{ message: "Queued" }]);
  assert.ok(log.includes('<time class="op-log-time">—</time>'));
  assert.ok(!log.includes('datetime=""'));
});

test("operationDetailPanel renders retry metadata alongside queue metadata when both apply", () => {
  const panel = operationDetailPanel({
    operation: {
      ...baseOperation,
      state: "delegated",
      phase: PHASES.RETRYING_CHECKS,
      strategy: STRATEGIES.MERGE_QUEUE,
      check_retry_count: 1,
      max_retries: 3,
      queue_position: 5,
      merge_queue_position: 2,
    },
    events: [],
  });
  assert.ok(panel.includes("Retry 1 of 3"));
  assert.ok(panel.includes("Queue position 5"));
  assert.ok(panel.includes("GitHub queue position 2"));
  assert.ok(panel.includes('<h4 class="op-log-heading">Activity</h4>'));
});

test("operationDetailPanel renders a loading placeholder for a null detail (not yet fetched)", () => {
  const panel = operationDetailPanel(null);
  assert.ok(panel.includes("Loading operation timeline"));
});

test("operationsList accepts an optional rendering-options object without requiring it", () => {
  const compact = operationsList([baseOperation]);
  assert.ok(!compact.includes("op-panel-row"));

  const expanded = operationsList([richOperation], {
    expandedId: richOperation.id,
    details: { [richOperation.id]: richDetail },
  });
  assert.ok(expanded.includes("op-panel-row"));
  assert.ok(expanded.includes("op-flow"));
  assert.ok(/op-step--current"[^>]*aria-current="step"/.test(expanded));
  assert.ok(expanded.includes('data-node-id="waiting_merge_queue"'));
});
