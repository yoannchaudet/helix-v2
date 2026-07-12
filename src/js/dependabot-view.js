/* Pure HTML templating for the Dependabot module: given a PR (or repo group), return the
 * markup string. No DOM access, no module state — so these are unit-testable and the
 * stateful controller (`dependabot.js`) owns all wiring/rendering. Reuses the shared row
 * building blocks (`authorTag`, `mergeStateBadge`, `pill`) so a Dependabot PR row reads like
 * a notification row, minus the bookmark/done affordances. */

import { html, rawHtml } from "./dom.js";
import { relTime } from "./format.js";
import { iconButton, pill } from "./ui.js";
import { authorTag, mergeStateBadge } from "./inbox-view.js";
import {
  buildOperationDetailModel,
  isActiveMergeOperation,
  repoDomId,
} from "./dependabot-model.js";

/** Static "PR" subject badge — every row here is a pull request. */
const PR_BADGE = pill("PR", "badge badge--pr");
const MERGE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 3v6a3 3 0 003 3h2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="4" cy="3" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="12" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 3h3v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CANCEL_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const OP_LABELS = {
  queued: "Queued",
  validating: "Validating",
  delegated: "Merging",
  cancel_requested: "Cancelling",
  merged: "Merged",
  cancelled: "Cancelled",
  failed: "Failed",
  timed_out: "Timed out",
};

function operationBadge(operation) {
  const tone =
    operation.state === "merged"
      ? "success"
      : operation.state === "failed" || operation.state === "timed_out"
        ? "error"
        : isActiveMergeOperation(operation)
          ? "pending"
          : "neutral";
  return pill(
    OP_LABELS[operation.state] || operation.state,
    `operation-state operation-state--${tone}`,
  );
}

/** One Dependabot PR as an openable row. Activating it opens `html_url` in the browser
 *  (wired by the controller). The merge-readiness pill reuses `mergeStateBadge` with a fixed
 *  PullRequest/open context (the module only ever lists open PRs). */
export function prRow(pr) {
  const number = html`<span class="n-number">#${pr.number}</span> `;
  const merge = mergeStateBadge(pr.mergeable_state, "PullRequest", "open");
  const stateLine = merge ? html`<div class="n-state">${rawHtml(merge)}</div>` : "";
  const author = pr.author ? authorTag(pr.author) : "";
  const target = pr.base_ref ? `Target: ${pr.base_ref} · ` : "";
  const operation = pr.active_merge_operation;
  const action = operation
    ? iconButton({
        icon: CANCEL_ICON,
        className: "dep-merge-action dep-merge-action--cancel is-on",
        title: "Cancel merge operation",
        label: `Cancel merge for "${pr.title}"`,
        attrs: html`data-operation-id="${operation.id}"`,
      })
    : iconButton({
        icon: MERGE_ICON,
        className: "dep-merge-action",
        title: "Queue merge",
        label: `Queue merge for "${pr.title}"`,
        attrs: html`data-pr-id="${pr.id}"`,
      });
  return html`
    <li class="n-row n-row--openable${operation ? " n-row--operation" : ""}" data-pr-id="${pr.id}">
      <div class="n-open" data-url="${pr.html_url}" role="link" tabindex="0">
        <span class="n-badge-slot">${rawHtml(PR_BADGE)}</span>
        <div class="n-main">
          <div class="n-title">${rawHtml(number)}${pr.title}</div>
          ${rawHtml(stateLine)}
          <div class="n-meta">${target}${relTime(pr.updated_at)}</div>
        </div>
        ${rawHtml(author)}
      </div>
      ${rawHtml(action)}
    </li>`;
}

/** Repo section header: the repository name (an `<h2>` so screen-reader users can navigate
 *  by heading) plus a count of its open Dependabot PRs. No mark-done affordance (read-only). */
export function repoHeader(group) {
  const counts = `<span class="repo-counts">${group.prs.length}</span>`;
  return html`
    <div class="repo-header">
      <h2 class="repo-name" id="${repoDomId(group.full_name)}">${group.full_name}</h2>
      ${rawHtml(counts)}
    </div>`;
}

/** A repository's PRs as a labeled group region (mirrors the inbox `repoSection`). */
export function repoSection(group) {
  const rows = group.prs.map(prRow).join("");
  return html`<section class="repo-section" role="group" aria-labelledby="${repoDomId(
    group.full_name,
  )}">${rawHtml(repoHeader(group))}<ul class="n-list">${rawHtml(rows)}</ul></section>`;
}

/** Stable id for an operation's expanded detail panel, so its disclosure button can point
 *  `aria-controls` at it (and the controller can look it up after a re-render). */
export function operationDetailPanelId(operationId) {
  return `dep-operation-panel-${operationId}`;
}

const STRATEGY_BRANCH_LABELS = {
  direct: "Direct merge",
  merge_queue: "Merge queue",
};

/** One read-only flow-graph node. The operation's current step is identified with
 *  `aria-current="step"`; per-step metadata remains available as a tooltip. */
function opNodeMarkup(node) {
  const current = node.state === "current" ? rawHtml(` aria-current="step"`) : "";
  const titleAttr = node.detail ? html` title="${node.detail}"` : "";
  return html`<li class="op-step op-step--${node.group} op-step--${node.state}"${current}>
    <span class="op-node" data-node-id="${node.id}" ${rawHtml(titleAttr)}>
      <span class="op-node-dot" aria-hidden="true"></span>
      <span class="op-node-label">${node.label}</span>
    </span>
  </li>`;
}

/** The compact, semantic flow visualization for one operation's graph (see
 *  `buildOperationGraph`): shared preparation steps, a labeled branch marker naming the
 *  strategy (or that it's still being determined), the strategy-specific steps, then the
 *  terminal step. A plain read-only `<ol>` — no canvas/SVG/diagramming dependency. */
export function operationFlow(graph) {
  const prep = graph.nodes.filter((node) => node.group === "prep" || node.group === "retry");
  const branch = graph.nodes.filter((node) => node.group === "branch");
  const terminal = graph.nodes.filter((node) => node.group === "terminal");
  const branchLabel = STRATEGY_BRANCH_LABELS[graph.strategy] || "Merge strategy not yet determined";
  const marker = branch.length
    ? html`<li class="op-flow-marker" role="presentation">${branchLabel}</li>`
    : "";
  const steps = prep.map(opNodeMarkup).join("");
  const branchSteps = branch.map(opNodeMarkup).join("");
  const terminalSteps = terminal.map(opNodeMarkup).join("");
  return html`<ol class="op-flow" data-strategy="${graph.strategy}" aria-label="Merge pipeline">${rawHtml(
    steps,
  )}${rawHtml(marker)}${rawHtml(branchSteps)}${rawHtml(terminalSteps)}</ol>`;
}

/** The ordered, timestamped action log for one operation's detail view. */
export function operationActionLog(actionLog) {
  if (!actionLog.length) {
    return html`<p class="op-log-empty">No actions recorded yet.</p>`;
  }
  const items = actionLog
    .map((event) => {
      const timestamp = event.timestamp
        ? html`<time class="op-log-time" datetime="${event.timestamp}">${relTime(
            event.timestamp,
          )}</time>`
        : html`<time class="op-log-time">—</time>`;
      const detail = event.detail ? html`<span class="op-log-detail">${event.detail}</span>` : "";
      return html`<li class="op-log-item">
        ${rawHtml(timestamp)}
        <span class="op-log-message">${event.message}</span>
        ${rawHtml(detail)}
      </li>`;
    })
    .join("");
  return html`<ol class="op-log">${rawHtml(items)}</ol>`;
}

/** The full expanded detail panel body: flow graph, retry/queue
 *  metadata, the current/next explanation, and the action log. `detail` is the raw
 *  `{ operation, events, current_explanation, next_action }` payload for this operation (or
 *  `null` while it's still being fetched, in which case a lightweight loading state renders
 *  instead of guessing at content). */
export function operationDetailPanel(detail) {
  if (!detail) {
    return html`<p class="op-panel-loading">Loading operation timeline…</p>`;
  }
  const model = buildOperationDetailModel(detail);
  const metaParts = [model.retry, model.queue, model.githubQueue].filter(Boolean);
  const metaLine = metaParts.length ? html`<p class="op-meta">${metaParts.join(" · ")}</p>` : "";
  const currentExplanation = model.currentExplanation
    ? html`<p class="op-explanation op-explanation--current">${model.currentExplanation}</p>`
    : "";
  const nextAction = model.nextAction
    ? html`<p class="op-explanation op-explanation--next">${model.nextAction}</p>`
    : "";
  return html`
    ${rawHtml(operationFlow(model.graph))}
    ${rawHtml(metaLine)} ${rawHtml(currentExplanation)} ${rawHtml(nextAction)}
    <h3 class="op-log-heading">Activity</h3>
    ${rawHtml(operationActionLog(model.actionLog))}
  `;
}

/** An icon-only disclosure button, independent of the PR-link and cancel controls, that
 *  toggles the inline detail panel. Always present (so the affordance is discoverable) —
 *  wiring the click/keyboard activation to actually fetch+expand detail is the controller's
 *  job; this only renders the correct `aria-expanded`/`aria-controls` for whatever state
 *  it's told about. */
function operationDisclosureButton(operation, expanded) {
  return iconButton({
    icon: CHEVRON_ICON,
    className: `dep-operation-disclosure${expanded ? " is-expanded" : ""}`,
    label: `${expanded ? "Hide" : "Show"} merge details for "${operation.title}"`,
    attrs: html`data-operation-id="${operation.id}" aria-expanded="${
      expanded ? "true" : "false"
    }" aria-controls="${operationDetailPanelId(operation.id)}"`,
  });
}

/** One merge operation as an openable row, with an accessible disclosure button (separate
 *  from the PR-link and cancel controls) that reveals an inline detail panel. By default
 *  (no `options`, or `options.expanded` falsy) this renders exactly the compact row from
 *  before — the disclosure button is the only structural addition, so existing callers keep
 *  working unchanged. Pass `{ expanded: true, detail }` to also render the flow graph,
 *  action log, and explanations (`detail` is the raw operation-detail payload; `null` while
 *  it's loading renders a lightweight placeholder instead of blank space). */
export function operationRow(operation, options = {}) {
  const { expanded = false, detail = null } = options;
  const errorDetail =
    operation.failure_reason || operation.last_error
      ? html`<div class="operation-error">${operation.failure_reason || operation.last_error}</div>`
      : "";
  const queue =
    operation.state === "queued" && operation.queue_position != null
      ? ` · queue ${operation.queue_position}`
      : "";
  const time = operation.terminal_at || operation.delegated_at || operation.enqueued_at;
  const target = operation.base_ref ? ` · Target: ${operation.base_ref}` : "";
  const cancel = isActiveMergeOperation(operation)
    ? iconButton({
        icon: CANCEL_ICON,
        className: "dep-operation-cancel",
        label: `Cancel merge for "${operation.title}"`,
        attrs: html`data-operation-id="${operation.id}"`,
      })
    : "";
  const disclosure = operationDisclosureButton(operation, expanded);
  const row = html`
    <li class="n-row n-row--openable operation-row" data-operation-id="${operation.id}">
      <div class="n-open" data-url="${operation.html_url}" role="link" tabindex="0">
        <span class="n-badge-slot">${rawHtml(operationBadge(operation))}</span>
        <div class="n-main">
          <div class="n-title"><span class="n-number">#${operation.number}</span> ${operation.title}</div>
          <div class="n-meta">${operation.repo_full_name}${target}${queue} · ${relTime(time)}</div>
          ${rawHtml(errorDetail)}
        </div>
      </div>
      ${rawHtml(disclosure)}
      ${rawHtml(cancel)}
    </li>`;
  if (!expanded) return row;
  const panel = html`
    <li class="op-panel-row" id="${operationDetailPanelId(
      operation.id,
    )}" data-operation-id="${operation.id}" role="group" aria-label="Merge details for ${operation.title}">
      ${rawHtml(operationDetailPanel(detail))}
    </li>`;
  return `${row}${panel}`;
}

/** `options` (all optional, defaulting to compact rendering identical to before Phase 2):
 *  - `expandedId`: id of the one operation whose row should render expanded.
 *  - `details`: `{ [operationId]: detailPayload }` — the raw `{ operation, events,
 *    current_explanation, next_action }` payload for the expanded operation (or omitted/
 *    `null` while it's still loading). */
export function operationsList(operations, options = {}) {
  const { expandedId = null, details = {} } = options;
  if (!operations.length) {
    return html`<div class="inbox-empty">
      <p class="inbox-empty-title">No merge operations yet.</p>
      <p class="inbox-empty-sub">Queue a merge from a Dependabot pull request.</p>
    </div>`;
  }
  const active = operations.filter(isActiveMergeOperation);
  const recent = operations.filter((operation) => !isActiveMergeOperation(operation));
  const renderRow = (operation) =>
    operationRow(operation, {
      expanded: operation.id === expandedId,
      detail: operation.id === expandedId ? (details[operation.id] ?? null) : null,
    });
  const section = (label, items) =>
    items.length
      ? html`<section class="repo-section operation-section">
          <div class="repo-header"><h2 class="repo-name">${label}</h2><span class="repo-counts">${items.length}</span></div>
          <ul class="n-list">${rawHtml(items.map(renderRow).join(""))}</ul>
        </section>`
      : "";
  return `${section("Active", active)}${section("Recent", recent)}`;
}
