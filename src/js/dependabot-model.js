/* Pure model logic for the Dependabot module: the repo-refine → sort pipeline over the
 * by-repo PR groups the backend returns. No DOM, no shared mutable state — every function
 * takes its inputs and returns new data, so this is the testable core the view renders from.
 *
 * A Dependabot group is `{ full_name, total, prs: [...] }` (see `dependabot::DependabotRepoGroup`
 * in Rust); repositories are refined by `full_name` (Dependabot has no notification-style
 * repo ids). Recency sorting reuses the generic helper shared with the inbox model. */

import { sortReposByRecency } from "./list-kit-model.js";

/** Apply the optional repository refinement (by `full_name`), then order repos
 *  most-recently-updated first. Returns new group objects; the input is not mutated. */
export function filterDependabotGroups(groups, repoName) {
  let result = groups;
  if (repoName != null) {
    result = result.filter((g) => g.full_name === repoName);
  }
  return sortReposByRecency(
    result,
    (g) => g.prs,
    (g) => g.full_name,
  );
}

/** Total number of PRs across all groups. */
export function totalPrs(groups) {
  return groups.reduce((n, g) => n + g.prs.length, 0);
}

/** A DOM-safe id fragment for a repository `full_name` (which contains `/`), used to tie a
 *  repo section to its heading via `aria-labelledby`. */
export function repoDomId(fullName) {
  return `dep-repo-${fullName.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}

export const ACTIVE_MERGE_STATES = new Set([
  "queued",
  "validating",
  "delegated",
  "cancel_requested",
]);

export const TERMINAL_MERGE_STATES = new Set(["merged", "cancelled", "failed", "timed_out"]);

/** Labels for terminal states used in announcements. */
export const TERMINAL_LABELS_ANNOUNCE = {
  merged: "merged",
  cancelled: "cancelled",
  failed: "failed",
  timed_out: "timed out",
};

/** Diff old and new operation lists, returning only *new* terminal transitions: operations
 *  whose state changed to a terminal state since the previous snapshot. Returns an array of
 *  `{ id, title, number, repo_full_name, state }` objects, one per newly-terminal operation.
 *  An unchanged terminal operation (same id + same state) is *not* included — it's old news. */
export function diffOperationStates(oldOps, newOps) {
  const oldById = new Map(oldOps.map((op) => [op.id, op]));
  const transitions = [];
  for (const op of newOps) {
    if (!TERMINAL_MERGE_STATES.has(op.state)) continue;
    const prev = oldById.get(op.id);
    if (prev && prev.state === op.state) continue; // unchanged
    transitions.push({
      id: op.id,
      title: op.title,
      number: op.number,
      repo_full_name: op.repo_full_name,
      state: op.state,
    });
  }
  return transitions;
}

/** Build a concise one-line summary of current operation state, suitable for announcing
 *  when the user returns to the Dependabot module. Returns `null` if there are no operations
 *  worth summarizing (no active work, no recent terminal events). */
export function operationStateSummary(operations) {
  const active = operations.filter(isActiveMergeOperation).length;
  const merged = operations.filter((op) => op.state === "merged").length;
  const failed = operations.filter(
    (op) => op.state === "failed" || op.state === "timed_out",
  ).length;
  const parts = [];
  if (active) parts.push(`${active} active`);
  if (merged) parts.push(`${merged} merged`);
  if (failed) parts.push(`${failed} failed`);
  if (!parts.length) return null;
  return `Operations: ${parts.join(", ")}.`;
}

export function isActiveMergeOperation(operation) {
  return ACTIVE_MERGE_STATES.has(operation.state);
}

/** Active work stays first in FIFO order; terminal history is newest first. */
export function sortMergeOperations(operations) {
  return [...operations].sort((a, b) => {
    const aActive = isActiveMergeOperation(a);
    const bActive = isActiveMergeOperation(b);
    if (aActive !== bActive) return aActive ? -1 : 1;
    const aTime = aActive ? a.enqueued_at : a.terminal_at || a.enqueued_at;
    const bTime = bActive ? b.enqueued_at : b.terminal_at || b.enqueued_at;
    return aActive
      ? String(aTime).localeCompare(String(bTime)) || a.id - b.id
      : String(bTime).localeCompare(String(aTime)) || b.id - a.id;
  });
}

export function activeMergeCount(operations) {
  return operations.filter(isActiveMergeOperation).length;
}

/* ---------------------------------------------------------------------------------------
 * Phase 2: the operation-detail flow graph.
 *
 * Once an operation is expanded, the backend hands us a richer detail payload:
 * `{ operation, events, current_explanation, next_action }`. `operation` still carries the
 * coarse lifecycle `state` used above (queued/validating/delegated/.../merged/failed/...),
 * plus finer-grained progress fields added for Phase 2: `phase` (one step within that
 * lifecycle), `strategy` (`unknown|direct|merge_queue` — how the merge will ultimately be
 * carried out), and retry/queue metadata: `check_retry_count` (consecutive check-run re-runs
 * for the current head SHA — the backend's actual field name; `retry_count`/`retries` are
 * accepted as a fallback for other callers/tests), Helix's own repo-scoped FIFO
 * `queue_position` (only meaningful while `state === "queued"`), and GitHub's native
 * `merge_queue_position` (only meaningful once GitHub's own merge queue has admitted the PR).
 *
 * `buildOperationGraph` turns that into a compact, linear step list — shared preparation
 * steps, then either the "direct merge" or "merge queue" branch, then a single terminal
 * step — each with a stable `id`, a friendly `label`, a rendering `state`, and a short
 * `detail` string. It never touches the DOM and never throws on missing/unexpected fields:
 * unknown phases/strategies degrade to a safe, mostly-"upcoming" graph instead of crashing.
 * --------------------------------------------------------------------------------------- */

export const STRATEGIES = {
  UNKNOWN: "unknown",
  DIRECT: "direct",
  MERGE_QUEUE: "merge_queue",
};

export const PHASES = {
  QUEUED: "queued",
  VALIDATING: "validating",
  UPDATING_BRANCH: "updating_branch",
  WAITING_REQUIREMENTS: "waiting_requirements",
  APPROVING_WORKFLOWS: "approving_workflows",
  WAITING_CHECKS: "waiting_checks",
  RETRY_SCHEDULED: "retry_scheduled",
  RETRYING_CHECKS: "retrying_checks",
  ENABLING_AUTO_MERGE: "enabling_auto_merge",
  WAITING_MERGE_QUEUE: "waiting_merge_queue",
  MERGING: "merging",
};

/** Terminal *operation states* (reusing the existing `state` field's vocabulary) — once the
 *  operation is in one of these, the graph is "done" and no further step is "current". */
const TERMINAL_STATES = new Set(["merged", "cancelled", "failed", "timed_out"]);

const TERMINAL_LABELS = {
  merged: "Merged",
  cancelled: "Cancelled",
  failed: "Failed",
  timed_out: "Timed out",
};

const PHASE_LABELS = {
  [PHASES.QUEUED]: "Queued",
  [PHASES.VALIDATING]: "Validating",
  [PHASES.UPDATING_BRANCH]: "Updating branch",
  [PHASES.WAITING_REQUIREMENTS]: "Waiting on requirements",
  [PHASES.APPROVING_WORKFLOWS]: "Approving workflows",
  [PHASES.WAITING_CHECKS]: "Waiting on checks",
  [PHASES.RETRY_SCHEDULED]: "Retry scheduled",
  [PHASES.RETRYING_CHECKS]: "Retrying checks",
  [PHASES.ENABLING_AUTO_MERGE]: "Enabling auto-merge",
  [PHASES.WAITING_MERGE_QUEUE]: "Waiting in merge queue",
  [PHASES.MERGING]: "Merging",
  strategy_detection: "Detecting merge strategy",
};

/** Shared preparation chain, common to every strategy (including "unknown"). The retry pair
 *  at the end is only ever meaningfully "done" when a retry actually happened — see
 *  `hasRetried` below — otherwise it renders as "skipped" so the graph doesn't imply retries
 *  occurred when the checks simply passed on the first try. */
const SHARED_PHASES = [
  PHASES.QUEUED,
  PHASES.VALIDATING,
  PHASES.UPDATING_BRANCH,
  PHASES.WAITING_REQUIREMENTS,
  PHASES.APPROVING_WORKFLOWS,
  PHASES.WAITING_CHECKS,
  PHASES.RETRY_SCHEDULED,
  PHASES.RETRYING_CHECKS,
];
const RETRY_PHASES = new Set([PHASES.RETRY_SCHEDULED, PHASES.RETRYING_CHECKS]);

const DIRECT_PHASES = [PHASES.MERGING];
const MERGE_QUEUE_PHASES = [PHASES.ENABLING_AUTO_MERGE, PHASES.WAITING_MERGE_QUEUE, PHASES.MERGING];

/** The operation's consecutive check-run retry count. `check_retry_count` is the backend's
 *  actual field name (see `DependabotMergeOperation` in Rust); `retry_count`/`retries` are
 *  accepted as a fallback so callers that build synthetic/partial operations still work. */
function retryCount(operation) {
  return operation.check_retry_count ?? operation.retry_count ?? operation.retries ?? 0;
}

/** Whether a retry has actually happened for this operation — driving the "skipped" vs
 *  "done" distinction for the shared retry-pair phases. */
function hasRetried(operation) {
  return retryCount(operation) > 0 || RETRY_PHASES.has(operation.phase);
}

/** A one-line "Retry N (of M)" summary, or `null` if the operation never retried. There is no
 *  backend-enforced retry cap (checks are retried on a backoff with no numeric limit), so `max`
 *  is only ever populated by a caller that tracks one itself. */
export function retrySummary(operation) {
  const count = retryCount(operation);
  if (!count) return null;
  const max = operation.max_retries ?? operation.retry_limit ?? null;
  return max != null ? `Retry ${count} of ${max}` : `Retry ${count}`;
}

/** A one-line "Queue position N" summary for Helix's own repo-scoped FIFO queue (the
 *  `queue_position` field — only meaningful while the operation is still `queued` behind
 *  another active operation in the same repo), or `null` if it has none. */
export function queueSummary(operation) {
  return operation.queue_position != null ? `Queue position ${operation.queue_position}` : null;
}

/** A one-line summary for GitHub's own native merge-queue position (the `merge_queue_position`
 *  field) — distinct from Helix's FIFO `queue_position` above: this only applies once the PR
 *  has actually been admitted to GitHub's merge queue. `null` if not applicable/not yet known. */
export function githubQueueSummary(operation) {
  return operation.merge_queue_position != null
    ? `GitHub queue position ${operation.merge_queue_position}`
    : null;
}

/** The label + detail for a single graph node id. `detail` folds in retry/queue metadata and
 *  the failure reason where relevant, so the view has a ready-to-escape string per node.
 *  Helix's own FIFO position (`queue_position`) surfaces on the shared `queued` step; GitHub's
 *  native merge-queue position (`merge_queue_position`) surfaces on the merge-queue branch's
 *  `waiting_merge_queue` step — the two are never conflated. */
function nodeLabel(id) {
  return PHASE_LABELS[id] || id;
}

function nodeDetail(id, operation) {
  if (RETRY_PHASES.has(id)) return retrySummary(operation) || "";
  if (id === PHASES.QUEUED) return queueSummary(operation) || "";
  if (id === PHASES.WAITING_MERGE_QUEUE) return githubQueueSummary(operation) || "";
  if (id === "terminal") return operation.failure_reason || operation.last_error || "";
  return "";
}

/** done|current|upcoming|skipped|failed for a step at `idx` in the linear `order`, given the
 *  operation is currently at `currentIndex` and may already be terminal. */
function stepState({ id, idx, currentIndex, isTerminal, succeeded, retried }) {
  if (idx < currentIndex) {
    if (RETRY_PHASES.has(id) && !retried) return "skipped";
    return "done";
  }
  if (idx === currentIndex) {
    if (isTerminal) return succeeded ? "done" : "failed";
    return "current";
  }
  // idx > currentIndex
  return isTerminal ? "skipped" : "upcoming";
}

/** Build the compact flow graph for one operation's detail view: shared preparation steps,
 *  then the strategy-specific branch, then a single terminal step. Never throws — a missing
 *  or unrecognized `phase`/`strategy` degrades to a safe (mostly "upcoming") graph rather
 *  than crashing the detail panel. */
export function buildOperationGraph(operation = {}) {
  const strategy = operation.strategy || STRATEGIES.UNKNOWN;
  const isTerminal = TERMINAL_STATES.has(operation.state);
  const succeeded = operation.state === "merged";
  const retried = hasRetried(operation);

  const branchPhases =
    strategy === STRATEGIES.DIRECT
      ? DIRECT_PHASES
      : strategy === STRATEGIES.MERGE_QUEUE
        ? MERGE_QUEUE_PHASES
        : [];
  const order = [...SHARED_PHASES, ...branchPhases, "terminal"];
  // The phase at which the operation currently sits (if active) or last reached before
  // terminating (if terminal) — either way, `operation.phase` is the source of truth; we
  // don't special-case terminal operations to "jump" to the end, so a failure during (say)
  // `waiting_checks` correctly leaves the branch-specific steps after it "skipped" rather
  // than implying they happened.
  let currentIndex = order.indexOf(operation.phase);
  if (currentIndex === -1) currentIndex = 0;

  const makeNode = (id, idx, group) => ({
    id,
    label: nodeLabel(id),
    state: stepState({ id, idx, currentIndex, isTerminal, succeeded, retried }),
    detail: nodeDetail(id, operation),
    group,
  });

  const nodes = SHARED_PHASES.map((id, i) =>
    makeNode(id, i, RETRY_PHASES.has(id) ? "retry" : "prep"),
  );

  if (strategy === STRATEGIES.UNKNOWN) {
    // The strategy hasn't been decided yet: show both possible branches as safe, inert
    // placeholders (namespaced ids so they never collide with a later real branch id) rather
    // than guessing. Once terminal without ever resolving, they're simply "skipped".
    const placeholder = (id, phase) => ({
      id,
      label: nodeLabel(phase),
      state: isTerminal ? "skipped" : "upcoming",
      detail: "",
      group: "branch",
    });
    nodes.push({
      id: "strategy_detection",
      label: nodeLabel("strategy_detection"),
      state: isTerminal ? "skipped" : "upcoming",
      detail: "",
      group: "branch",
    });
    nodes.push(...DIRECT_PHASES.map((id) => placeholder(`direct:${id}`, id)));
    nodes.push(...MERGE_QUEUE_PHASES.map((id) => placeholder(`queue:${id}`, id)));
  } else {
    branchPhases.forEach((id, i) => {
      nodes.push(makeNode(id, SHARED_PHASES.length + i, "branch"));
    });
  }

  // The terminal step is always resolved from the operation's outcome directly (not from a
  // position-in-`order` comparison) — it's "done" once merged, "failed" for any other
  // terminal state (failed/cancelled/timed_out), and "upcoming" while still active.
  nodes.push({
    id: "terminal",
    label: isTerminal ? TERMINAL_LABELS[operation.state] || "Completing" : "Completing",
    state: isTerminal ? (succeeded ? "done" : "failed") : "upcoming",
    detail: nodeDetail("terminal", operation),
    group: "terminal",
  });

  return { strategy, phase: operation.phase ?? null, nodes };
}

/** Normalize+order an operation's action-event log oldest-first, tolerating events missing a
 *  parseable `timestamp` (they fall back to their original array position rather than being
 *  dropped or sorted arbitrarily). Fields are normalized to `{ id, timestamp, message, detail }`
 *  so the view can render them uniformly regardless of the exact API event shape. */
export function buildActionLog(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, index) => ({
      id: event.id ?? `${event.timestamp ?? "event"}-${index}`,
      timestamp: event.timestamp ?? event.at ?? event.created_at ?? null,
      message: event.message ?? event.summary ?? event.description ?? event.label ?? "",
      detail: event.detail ?? event.context ?? "",
      _index: index,
    }))
    .sort((a, b) => {
      const at = a.timestamp ? Date.parse(a.timestamp) : NaN;
      const bt = b.timestamp ? Date.parse(b.timestamp) : NaN;
      if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
      if (!Number.isNaN(at) !== !Number.isNaN(bt)) return Number.isNaN(at) ? 1 : -1;
      return a._index - b._index;
    })
    .map(({ _index, ...rest }) => rest);
}

/** Assemble everything the detail panel needs from the raw `{ operation, events,
 *  current_explanation, next_action }` payload: the flow graph, the ordered action log, the
 *  escapable explanation/next-action strings, and the retry/queue one-liners (`queue` is
 *  Helix's own FIFO position, `githubQueue` is GitHub's native merge-queue position — kept
 *  distinct since they can both be present at different points in an operation's life). Pure —
 *  the view is responsible for turning this into (escaped) HTML. */
export function buildOperationDetailModel(detail) {
  const operation = detail?.operation || {};
  return {
    graph: buildOperationGraph(operation),
    actionLog: buildActionLog(detail?.events),
    currentExplanation: detail?.current_explanation || "",
    nextAction: detail?.next_action || "",
    retry: retrySummary(operation),
    queue: queueSummary(operation),
    githubQueue: githubQueueSummary(operation),
  };
}
