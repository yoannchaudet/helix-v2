import { invoke, listen } from "./api.js";
import { $, html, toast, enqueueAnnounce, clearAnnounceQueue } from "./dom.js";
import { POLL_TICK_MS, STATES } from "./constants.js";
import { relTime } from "./format.js";
import {
  activeMergeCount,
  diffOperationStates,
  filterDependabotGroups,
  isActiveMergeOperation,
  operationStateSummary,
  sortMergeOperations,
  TERMINAL_LABELS_ANNOUNCE,
  totalPrs,
} from "./dependabot-model.js";
import { operationsList, repoSection } from "./dependabot-view.js";
import { sourceButton } from "./ui.js";
import { isAuthenticated } from "./account.js";
import { closeMenu, isMenuOpen, openContextMenu } from "./menu.js";
import { isShortcutsOpen } from "./shortcuts.js";
import { dependabotMergePoll } from "./state.js";
import { getActiveModule, registerModule } from "./modules.js";
import {
  createHoverManager,
  createKbdFocusRing,
  createRowNavigator,
  createListFocusRetainer,
} from "./list-kit.js";

/* The Bot PRs module: a list of open PRs from supported automation bots grouped by
 * repository, its
 * repo-only sidebar refinement, keyboard navigation, and its own sync flow. Pure row/section
 * HTML lives in `dependabot-view.js`; the pure repo pipeline in `dependabot-model.js`; this
 * module owns all state and DOM wiring. Deliberately trimmed vs. the inbox: no smart filters,
 * no type pills, no bookmarks, no mark-done.
 *
 * Data is offline-first: `loadDependabot` reads the cached PRs from SQLite (`list_dependabot`)
 * and GitHub is only contacted on a sync (`sync_dependabot`). Auto-sync on module open is
 * staleness-gated (see `onDependabotOpened`) so repeated opens don't re-scan every time. */

/** By-repo PR groups from the backend (`{ full_name, total, prs }[]`). */
let depGroups = [];
let mergeOperations = [];
let activeView = "prs";
/** Optional repository refinement: a `full_name`, or null for "all repositories". */
let activeRepo = null;
/** True while a sync is in flight; gates stale `dependabot:progress` events. */
let syncing = false;
/** Set when a sync is requested while one is already running (e.g. the account scope changed
 *  mid-sync), so exactly one follow-up runs with the latest scope. */
let pendingSync = false;
/** Epoch ms of the last successful sync this session (0 = never). Drives the staleness
 *  gate for auto-sync-on-open and the status label. */
let lastSyncAt = 0;
/** Resolves once the persisted last-sync time has been read (or the read failed). The
 *  auto-sync staleness gate awaits it so a restart doesn't re-scan a still-fresh sync. */
let statusLoaded = Promise.resolve();
let operationPollTimer = null;
let operationPollElapsed = 0;
let operationTicking = false;
let loadGeneration = 0;
let pollStartGeneration = 0;
let expandedOperationId = null;
let operationDetails = {};
let operationDetailGeneration = 0;
const pendingDiscardPrIds = new Set();
const discardRequestsInFlight = new Set();

/** Terminal transitions that arrived while another module was active. Accumulated by
 *  `applySnapshot` and flushed by `onDependabotOpened` as a concise on-return summary. */
let missedTransitions = [];

/** Whether we've received at least one operation snapshot. The first snapshot establishes a
 *  baseline — its terminal operations are not announced as transitions, since they may be
 *  historical state loaded from SQLite on startup. */
let hasOperationBaseline = false;

/** Auto-sync-on-open only fires if we've never synced this session or it's been at least
 *  this long since the last sync — so repeated opens don't re-scan the repo list every time. */
const AUTO_SYNC_STALE_MS = 5 * 60 * 1000;

/** Whether the Bot PRs module is the currently visible module. */
function isDependabotActive() {
  return getActiveModule() === "dependabot";
}

/* ------------------------------ Unified snapshot ------------------------------ */

/** Single path for applying a new `{ groups, operations }` snapshot to module state.
 *  Every snapshot-loading path (`loadDependabot`, `reloadOperations`,
 *  `startDependabotMergePolling`) must use this instead of inlining the logic.
 *
 *  Handles:
 *  1. Replacing `depGroups` and `mergeOperations`.
 *  2. Clearing a vanished `activeRepo` refinement.
 *  3. Invalidating a vanished `expandedOperationId` and bumping `operationDetailGeneration`.
 *  4. Diffing old/new operation states and announcing terminal transitions (or queuing them
 *     as `missedTransitions` when another module is active). */
function applySnapshot(groups, operations) {
  const oldOps = mergeOperations;
  depGroups = groups;
  mergeOperations = operations;

  // (1) Clear a repo refinement whose repository no longer exists in the new snapshot.
  if (activeRepo != null && !depGroups.some((g) => g.full_name === activeRepo)) {
    activeRepo = null;
  }

  // (2) Invalidate a vanished expanded operation and stale detail request.
  if (expandedOperationId != null && !mergeOperations.some((op) => op.id === expandedOperationId)) {
    expandedOperationId = null;
    operationDetailGeneration += 1;
  }

  // (3) Diff for terminal transitions and announce or queue them. Skip on the first
  //     snapshot (establishing the baseline) so historical terminal operations from SQLite
  //     are not falsely announced as new transitions on startup.
  if (!hasOperationBaseline) {
    hasOperationBaseline = true;
  } else {
    const transitions = diffOperationStates(oldOps, mergeOperations);
    if (transitions.length) {
      if (isDependabotActive()) {
        for (const t of transitions) {
          const label = TERMINAL_LABELS_ANNOUNCE[t.state] || t.state;
          enqueueAnnounce(`#${t.number} ${label}.`);
        }
      } else {
        missedTransitions.push(...transitions);
      }
    }
  }
}

/** Announce a concise on-return summary of operation state and any missed transitions that
 *  arrived while another module was active. */
function announceReturnSummary() {
  // First, flush missed transitions.
  if (missedTransitions.length) {
    const counts = {};
    for (const t of missedTransitions) {
      const label = TERMINAL_LABELS_ANNOUNCE[t.state] || t.state;
      counts[label] = (counts[label] || 0) + 1;
    }
    const parts = Object.entries(counts).map(([label, n]) => `${n} ${label}`);
    enqueueAnnounce(`While away: ${parts.join(", ")}.`);
    missedTransitions = [];
  }
  // Then, summarize current state.
  const summary = operationStateSummary(mergeOperations);
  if (summary) enqueueAnnounce(summary);
}

const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
// Matches the notifications "All" smart-filter icon for cross-module consistency.
const ALL_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l1.6 1.7L10.6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const OPERATIONS_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 4h10M3 8h10M3 12h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="5" cy="4" r="1.4" fill="currentColor"/><circle cx="9" cy="8" r="1.4" fill="currentColor"/><circle cx="7" cy="12" r="1.4" fill="currentColor"/></svg>`;

/* -------------------------------- Rendering ------------------------------- */

/** The groups to show: the active repo refinement (if any), recency-sorted. */
function visibleGroups() {
  return filterDependabotGroups(depGroups, activeRepo);
}

function emptyDependabot() {
  if (!isAuthenticated()) {
    return html`<div class="inbox-empty">
      <p>Connect your GitHub account to see bot pull requests.</p>
    </div>`;
  }
  return html`<div class="inbox-empty">
    <img class="inbox-empty-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
    <p class="inbox-empty-title">No open bot pull requests.</p>
    <p class="inbox-empty-sub">
      Repositories appear here as they show up in your notifications, so sync
      <span class="inbox-empty-hint">Notifications</span> to populate the list — then their open
      PRs from supported bots are collected here.
    </p>
  </div>`;
}

const focusRetainer = createListFocusRetainer({
  containerSelector: "#dependabot",
  rowSelector: ".n-row",
  captureTarget: (row, active) => {
    if (row.dataset.operationId) {
      return {
        kind: "operation",
        id: row.dataset.operationId,
        kbd: active.classList.contains("kbd-focus"),
        part: active.classList.contains("dep-discard-action")
          ? "discard"
          : active.classList.contains("dep-operation-cancel")
            ? "cancel"
            : active.classList.contains("dep-operation-disclosure")
              ? "disclosure"
              : "open",
      };
    }
    return row.dataset.prId
      ? {
          kind: "pr",
          id: row.dataset.prId,
          kbd: active.classList.contains("kbd-focus"),
          part: active.classList.contains("dep-discard-action")
            ? "discard"
            : active.classList.contains("dep-merge-action")
              ? "action"
              : "open",
        }
      : null;
  },
  matchRow: (row, target) =>
    target.kind === "operation"
      ? row.dataset.operationId === target.id
      : row.dataset.prId === target.id,
  resolveElement: (row, target) =>
    target.part === "discard"
      ? row.querySelector(".dep-discard-action") || row.querySelector(".n-open[tabindex]")
      : target.kind === "operation" && target.part === "cancel"
        ? row.querySelector(".dep-operation-cancel") || row.querySelector(".n-open[tabindex]")
        : target.kind === "operation" && target.part === "disclosure"
          ? row.querySelector(".dep-operation-disclosure") || row.querySelector(".n-open[tabindex]")
          : target.kind === "pr" && target.part === "action"
            ? row.querySelector(".dep-merge-action") || row.querySelector(".n-open[tabindex]")
            : row.querySelector(".n-open[tabindex]"),
});

const kbdFocus = createKbdFocusRing({ containerSelector: "#dependabot" });

/** Snapshot the focused PR row id so a re-render can restore focus (the list re-renders
 *  wholesale on refine/sync, which would otherwise drop focus to <body>). */
function captureFocus() {
  return focusRetainer.capture();
}

/** Restore focus to the same PR/operation control after a re-render. */
function applyFocus(target, { preventScroll = false } = {}) {
  const landed = focusRetainer.apply(target, { preventScroll });
  if (!landed) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (target?.kbd) kbdFocus.apply(active);
    else kbdFocus.clear();
  }
  return true;
}

/** Render the central PR list for the active repo refinement. A live re-render (e.g. from a
 *  `dependabot:operations-changed` event, or after a fetch resolves) replaces the whole list's
 *  markup — capture+restore the scroll position around that (in addition to focus, via
 *  `captureFocus`/`applyFocus`) so it doesn't visibly jump back to the top mid-session. */
function renderList() {
  const list = $("#dependabot");
  if (!list) return;
  const preserved = captureFocus();
  const scrollTop = list.scrollTop;
  clearDependabotHover();
  if (activeView === "operations") {
    list.innerHTML = operationsList(sortMergeOperations(mergeOperations), {
      expandedId: expandedOperationId,
      details: operationDetails,
    });
    list.scrollTop = scrollTop;
    if (preserved != null && !applyFocus(preserved, { preventScroll: true })) {
      list.querySelector(".n-open[tabindex]")?.focus({ preventScroll: true });
    }
    applyPendingDiscardState();
    return;
  }

  const groups = visibleGroups();
  if (!groups.length) {
    list.innerHTML = emptyDependabot();
    return;
  }
  list.innerHTML = groups.map(repoSection).join("");
  list.scrollTop = scrollTop;
  if (preserved != null && !applyFocus(preserved, { preventScroll: true })) {
    list.querySelector(".n-open[tabindex]")?.focus({ preventScroll: true });
  }
  applyPendingDiscardState();
}

function applyPendingDiscardState() {
  for (const button of $("#dependabot")?.querySelectorAll(".dep-discard-action") ?? []) {
    const pending = pendingDiscardPrIds.has(Number(button.dataset.prId));
    button.disabled = pending;
    button.classList.toggle("is-pending", pending);
    if (pending) button.title = "Waiting to close pull request";
  }
}

/** Clear hover markers via the shared hover manager. */
function clearDependabotHover() {
  hoverManager.clear();
}

function confirmDiscard(button) {
  const prId = Number(button.dataset.prId);
  if (!Number.isFinite(prId) || pendingDiscardPrIds.has(prId)) return;
  const title = button.dataset.prTitle || "this pull request";
  const rect = button.getBoundingClientRect();
  openContextMenu(rect.left, rect.bottom + 4, [
    {
      label: `Confirm: discard and close ${title}`,
      danger: true,
      action: () => beginDiscard(prId),
    },
    { label: "Cancel", action: () => {} },
  ]);
}

function confirmForgetOperation(button) {
  const operationId = Number(button.dataset.operationId);
  if (!Number.isFinite(operationId)) return;
  const title = button.dataset.operationTitle || "this operation";
  const rect = button.getBoundingClientRect();
  openContextMenu(rect.left, rect.bottom + 4, [
    {
      label: `Confirm: forget ${title} locally — Helix will stop retrying, but GitHub may still merge the pull request`,
      danger: true,
      action: () => forgetOperation(operationId),
    },
    { label: "Cancel", action: () => {} },
  ]);
}

async function forgetOperation(operationId) {
  try {
    await invoke("forget_stuck_dependabot_merge", { operationId });
    enqueueAnnounce("Forgot the local operation. GitHub may still merge the pull request.");
    await reloadOperations();
  } catch (err) {
    toast(String(err), "error");
  }
}

function beginDiscard(prId) {
  pendingDiscardPrIds.add(prId);
  applyPendingDiscardState();
  continueDiscard(prId);
}

async function continueDiscard(prId) {
  if (!pendingDiscardPrIds.has(prId) || discardRequestsInFlight.has(prId)) return;
  discardRequestsInFlight.add(prId);
  try {
    const result = await invoke("discard_dependabot_pr", { prId });
    if (result.status === "closed") {
      pendingDiscardPrIds.delete(prId);
      enqueueAnnounce("Pull request discarded and closed.");
      await loadDependabot();
      return;
    }
    enqueueAnnounce("Cancelling merge before closing pull request.");
    await reloadOperations();
    operationPollElapsed = Number.POSITIVE_INFINITY;
    processMergeOperations();
  } catch (err) {
    pendingDiscardPrIds.delete(prId);
    toast(String(err), "error");
    await loadDependabot();
  } finally {
    discardRequestsInFlight.delete(prId);
    applyPendingDiscardState();
  }
}

function resumePendingDiscards() {
  for (const prId of pendingDiscardPrIds) {
    const active = mergeOperations.some(
      (operation) => operation.pr_id === prId && isActiveMergeOperation(operation),
    );
    if (!active) continueDiscard(prId);
  }
}

/* Row hover: same WKWebView workaround as the inbox — see list-kit.js for rationale. */
const hoverManager = createHoverManager({
  containerSelector: "#dependabot",
  rowHoverClass: "n-row--hover",
});

/** Render the repo-only sidebar for the Bot PRs module (counts + active highlight). */
function renderSidebar() {
  const filterList = $("#dependabot-filter-list");
  if (filterList) {
    const activeOperationCount = activeMergeCount(mergeOperations);
    // "All" mirrors the notifications smart filter: total open PRs, active when no repo is
    // refined, and clicking it clears any repo refinement.
    filterList.innerHTML =
      sourceButton({
        icon: ALL_ICON,
        label: "All",
        attrs: html`data-filter="all"`,
        active: activeView === "prs" && activeRepo == null,
        count: depGroups.length ? String(totalPrs(depGroups)) : "",
      }) +
      sourceButton({
        icon: OPERATIONS_ICON,
        label: "Operations",
        attrs: html`data-filter="operations"`,
        active: activeView === "operations",
        count: activeOperationCount ? String(activeOperationCount) : "",
      });
    filterList.querySelector('[data-filter="all"]')?.addEventListener("click", clearRepo);
    filterList
      .querySelector('[data-filter="operations"]')
      ?.addEventListener("click", selectOperations);
  }

  const repoList = $("#dependabot-repo-list");
  if (!repoList) return;
  if (!depGroups.length) {
    repoList.innerHTML = html`<li class="source-empty">No repositories yet.</li>`;
    return;
  }
  // Same recency order as the main list so the sidebar matches the view.
  const ordered = filterDependabotGroups(depGroups, null);
  repoList.innerHTML = ordered
    .map((g) =>
      sourceButton({
        icon: REPO_ICON,
        label: g.full_name,
        labelTitle: g.full_name,
        className: "repo-source",
        attrs: html`data-repo="${g.full_name}"`,
        active: activeView === "prs" && g.full_name === activeRepo,
        count: g.prs.length ? String(g.prs.length) : "",
      }),
    )
    .join("");
  for (const btn of repoList.querySelectorAll(".repo-source")) {
    btn.addEventListener("click", () => selectRepo(btn.dataset.repo));
  }
  for (const btn of repoList.querySelectorAll(".source[data-repo]")) {
    const active = btn.dataset.repo === activeRepo;
    btn.classList.toggle("source--active", active);
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** Update the toolbar breadcrumb to reflect the active repo refinement. */
function renderTitle() {
  const title = $("#dependabot-view-title");
  if (!title) return;
  if (activeView === "operations") {
    title.innerHTML = html`Bot PRs<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">Operations</span>`;
    title.setAttribute("aria-label", "Bot PRs, merge operations");
  } else if (activeRepo != null) {
    title.innerHTML = html`Bot PRs<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${activeRepo}</span>`;
    title.setAttribute("aria-label", `Bot PRs, repository ${activeRepo}`);
  } else {
    title.textContent = "Bot PRs";
    title.removeAttribute("aria-label");
  }
}

/** Announce the current view to assistive tech (the visual heading change isn't announced). */
function announceView() {
  if (activeView === "operations") {
    const count = mergeOperations.length;
    enqueueAnnounce(
      `Bot PRs merge operations, ${count} ${count === 1 ? "operation" : "operations"}.`,
    );
    return;
  }
  const count = totalPrs(visibleGroups());
  const noun = count === 1 ? "pull request" : "pull requests";
  const where = activeRepo != null ? `Bot PRs, repository ${activeRepo}` : "Bot PRs";
  enqueueAnnounce(`${where}, ${count} ${noun}.`);
}

/** Toggle the repository refinement: select it, or clear it if already active. */
function selectRepo(fullName, kbd = false) {
  activeView = "prs";
  activeRepo = activeRepo === fullName ? null : fullName;
  renderTitle();
  renderSidebar();
  renderList();
  if (kbd) focusFirstRow(true);
  announceView();
}

/** Clear any repository refinement (the sidebar "All" entry). No-op if already cleared. */
function clearRepo() {
  if (activeRepo == null && activeView === "prs") return;
  activeView = "prs";
  activeRepo = null;
  renderTitle();
  renderSidebar();
  renderList();
  announceView();
}

function selectOperations() {
  activeView = "operations";
  activeRepo = null;
  renderTitle();
  renderSidebar();
  renderList();
  resumePendingDiscards();
  announceView();
}

/* --------------------------------- Loading -------------------------------- */

/** Load cached supported automation PRs from SQLite and render (offline-first; no network). */
export async function loadDependabot() {
  const generation = ++loadGeneration;
  try {
    const [groups, operations] = await Promise.all([
      invoke("list_dependabot"),
      invoke("list_dependabot_merge_operations"),
    ]);
    if (generation !== loadGeneration) return;
    applySnapshot(groups, operations);
    renderTitle();
    renderSidebar();
    renderList();
  } catch (err) {
    if (generation !== loadGeneration) return;
    $("#dependabot").innerHTML = html`<pre class="error-detail">${err}</pre>`;
  }
}

async function reloadOperations() {
  const generation = ++loadGeneration;
  try {
    const [groups, operations] = await Promise.all([
      invoke("list_dependabot"),
      invoke("list_dependabot_merge_operations"),
    ]);
    if (generation !== loadGeneration) return;
    applySnapshot(groups, operations);
    renderTitle();
    renderSidebar();
    if (!$("#view-dependabot")?.hidden) renderList();
    if (expandedOperationId != null) refreshExpandedOperationDetail();
    resumePendingDiscards();
  } catch (err) {
    console.error(`failed to load Dependabot merge operations: ${err}`);
  }
}

/* -------------------------------- Interactions ---------------------------- */

/** Open a PR in the default browser via the backend. */
function openPr(url) {
  if (!url) return;
  invoke("open_url", { url }).catch((err) => {
    console.error(`failed to open ${url}: ${err}`);
    toast("Couldn't open link", "error");
  });
}

/** Left-click an openable PR row → open it in the browser. */
function onListClick(e) {
  if (e.detail > 1) return; // ignore the second click of a double-click
  const el = e.target instanceof Element ? e.target : e.target?.parentElement;
  const disclosure = el?.closest(".dep-operation-disclosure");
  if (disclosure?.dataset.operationId) {
    toggleOperationDetail(Number(disclosure.dataset.operationId));
    return;
  }
  const discard = el?.closest(".dep-discard-action");
  if (discard?.dataset.prId) {
    confirmDiscard(discard);
    return;
  }
  const merge = el?.closest(".dep-merge-action");
  if (merge) {
    if (merge.dataset.operationId) cancelMerge(merge.dataset.operationId);
    else if (merge.dataset.prId) enqueueMerge(merge.dataset.prId);
    return;
  }
  const cancel = el?.closest(".dep-operation-cancel");
  if (cancel?.dataset.operationId) {
    cancelMerge(cancel.dataset.operationId);
    return;
  }
  const forget = el?.closest(".dep-operation-forget");
  if (forget?.dataset.operationId) {
    confirmForgetOperation(forget);
    return;
  }
  const open = el?.closest(".n-open");
  if (open?.dataset.url) openPr(open.dataset.url);
}

/** Re-fetch the currently-expanded operation's detail (used both right after expanding it and
 *  to refresh a still-expanded panel on a live `dependabot:operations-changed` event). Guards
 *  against stale responses two ways: `operationDetailGeneration` is bumped by every
 *  toggle/collapse so an in-flight fetch that resolves after the user acted again is dropped,
 *  and the resolved `operationId` is re-checked against the *current* `expandedOperationId` in
 *  case the panel was collapsed (or a different one opened) while this fetch was in flight. */
async function refreshExpandedOperationDetail() {
  const operationId = expandedOperationId;
  if (operationId == null) return;
  const generation = ++operationDetailGeneration;
  try {
    const detail = await invoke("get_dependabot_merge_operation_detail", { operationId });
    if (generation !== operationDetailGeneration || operationId !== expandedOperationId) return;
    operationDetails = { ...operationDetails, [operationId]: detail };
    renderList();
  } catch (err) {
    if (generation !== operationDetailGeneration || operationId !== expandedOperationId) return;
    console.error(`failed to load Dependabot merge operation ${operationId}: ${err}`);
    toast("Couldn't load merge operation details", "error");
  }
}

/** Toggle one operation's inline detail disclosure — collapsing it if already expanded
 *  (only one operation's detail is ever expanded at a time), otherwise expanding it: render
 *  immediately with a loading placeholder (`detail: null`), then fetch+refresh. */
function toggleOperationDetail(operationId) {
  if (expandedOperationId === operationId) {
    expandedOperationId = null;
    operationDetailGeneration += 1;
    renderList();
    return;
  }
  expandedOperationId = operationId;
  operationDetails = { ...operationDetails, [operationId]: null };
  renderList();
  refreshExpandedOperationDetail();
}

/** Enter on a focused PR row → open it (links activate on Enter, not Space). Explicitly
 *  excludes the disclosure/cancel/merge-action buttons — they're real `<button>`s so
 *  Enter already activates their own click handler natively; this guard just keeps that
 *  activation from *also* bubbling into opening the PR link. */
function onListKeydown(e) {
  if (e.key !== "Enter") return;
  if (
    e.target.closest?.(
      ".dep-merge-action, .dep-discard-action, .dep-operation-cancel, .dep-operation-forget, .dep-operation-disclosure",
    )
  ) {
    return;
  }
  const open = e.target.closest?.(".n-open");
  if (!open?.dataset.url) return;
  e.preventDefault();
  openPr(open.dataset.url);
}

async function enqueueMerge(prId) {
  try {
    await invoke("enqueue_dependabot_merge", { prId: Number(prId) });
    enqueueAnnounce("Merge queued.");
    await reloadOperations();
    operationPollElapsed = Number.POSITIVE_INFINITY;
    processMergeOperations();
  } catch (err) {
    toast(String(err), "error");
  }
}

async function cancelMerge(operationId) {
  try {
    const operation = await invoke("cancel_dependabot_merge", {
      operationId: Number(operationId),
    });
    enqueueAnnounce(
      operation.state === "cancelled" ? "Merge operation cancelled." : "Cancelling merge.",
    );
    await reloadOperations();
    operationPollElapsed = Number.POSITIVE_INFINITY;
    processMergeOperations();
  } catch (err) {
    toast(String(err), "error");
  }
}

/* ------------------------- Keyboard command model ------------------------- */

/** Focus a dependabot row (used by the navigator). */
function focusRow(row, kbd = true) {
  const target = row.querySelector(".n-open[tabindex]");
  if (!target) return;
  if (kbd) kbdFocus.apply(target);
  else kbdFocus.clear();
  target.focus();
}

function focusFirstRow(kbd = true, force = false) {
  if (!kbd && !force) return;
  const first = $("#dependabot")?.querySelector(".n-row");
  if (first) focusRow(first, kbd);
}

/** Shared row navigator (j/k movement, activeRow, rows). */
const nav = createRowNavigator({
  containerSelector: "#dependabot",
  rowSelector: ".n-row",
  focusRow,
});

async function processMergeOperations() {
  if (!isAuthenticated() || operationTicking || !activeMergeCount(mergeOperations)) return;
  if (Date.now() < dependabotMergePoll.backoffUntilMs) return;
  operationTicking = true;
  operationPollElapsed = 0;
  try {
    const result = await invoke("process_dependabot_merges");
    if (result) applyMergeStatus(result.status ?? result);
    await reloadOperations();
  } catch (err) {
    console.error(`Dependabot merge processing failed: ${err}`);
    setDepProgress(String(err), "error");
  } finally {
    operationTicking = false;
  }
}

function applyMergeStatus(status) {
  dependabotMergePoll.intervalSeconds =
    Number(status.poll_interval_s) || dependabotMergePoll.intervalSeconds;
  dependabotMergePoll.minIntervalS =
    Number(status.min_poll_interval_s) || dependabotMergePoll.minIntervalS;
  dependabotMergePoll.githubFloorS = Number(status.github_poll_floor_s) || 0;
  dependabotMergePoll.backoffUntilMs = Date.parse(status.backoff_until) || 0;
}

async function operationPollTick() {
  if (!isAuthenticated() || operationTicking || !activeMergeCount(mergeOperations)) return;
  if (Date.now() < dependabotMergePoll.backoffUntilMs) return;
  operationPollElapsed += 1;
  const interval = Math.max(
    dependabotMergePoll.intervalSeconds,
    dependabotMergePoll.minIntervalS,
    dependabotMergePoll.githubFloorS,
  );
  if (operationPollElapsed >= interval) processMergeOperations();
}

export async function startDependabotMergePolling() {
  stopDependabotMergePolling(false);
  const pollGeneration = ++pollStartGeneration;
  const generation = ++loadGeneration;
  try {
    const [groups, operations, status] = await Promise.all([
      invoke("list_dependabot"),
      invoke("list_dependabot_merge_operations"),
      invoke("dependabot_merge_status"),
    ]);
    if (pollGeneration !== pollStartGeneration) return;
    if (generation === loadGeneration) {
      applySnapshot(groups, operations);
      applyMergeStatus(status);
      renderTitle();
      renderSidebar();
      if (!$("#view-dependabot")?.hidden) renderList();
      resumePendingDiscards();
    }
  } catch (err) {
    if (pollGeneration !== pollStartGeneration) return;
    if (generation === loadGeneration) {
      console.error(`failed to start Dependabot merge polling: ${err}`);
    }
  }
  operationPollTimer = setInterval(operationPollTick, POLL_TICK_MS);
  if (activeMergeCount(mergeOperations)) processMergeOperations();
}

export function stopDependabotMergePolling(clearPendingDiscards = true) {
  pollStartGeneration += 1;
  if (operationPollTimer) clearInterval(operationPollTimer);
  operationPollTimer = null;
  operationPollElapsed = 0;
  if (clearPendingDiscards) {
    pendingDiscardPrIds.clear();
    discardRequestsInFlight.clear();
  }
}

/** Global triage keydown: active only on the Dependabot pane, no modifier, not while typing
 *  or while a menu/overlay owns the keyboard. j/k navigate, Enter opens (handled on the row),
 *  r syncs. */
function onCommandKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable)) {
    return;
  }
  if (isMenuOpen() || isShortcutsOpen()) return;
  if ($("#view-dependabot")?.hidden) return;

  switch (e.key) {
    case "j":
    case "ArrowDown":
      e.preventDefault();
      nav.moveActiveRow(1);
      return;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      nav.moveActiveRow(-1);
      return;
    case "r":
      e.preventDefault();
      syncDependabot();
      return;
  }
}

/* ---------------------------- Sync status + flow -------------------------- */

function setDepStatus(state, text) {
  const dot = $(".js-dep-sync-dot");
  if (dot) {
    for (const s of STATES) dot.classList.remove(`status-dot--${s}`);
    dot.classList.add(`status-dot--${state}`);
  }
  const label = $(".js-dep-sync-label");
  if (label) {
    for (const s of STATES) label.classList.remove(`status-label--${s}`);
    label.classList.add(`status-label--${state}`);
    label.textContent = text;
  }
}

function setDepProgress(text, kind = "") {
  const el = $(".js-dep-sync-progress");
  if (el) {
    el.className = `form-msg js-dep-sync-progress${kind ? ` form-msg--${kind}` : ""}`;
    el.textContent = text;
  }
}

function setDepBusy(busy) {
  const btn = $("#dependabot-sync-btn");
  if (btn) {
    btn.disabled = busy;
    btn.classList.toggle("is-due", busy);
  }
}

/** Reflect the idle status label from `lastSyncAt` (neutral; green is only shown transiently
 *  right after a sync succeeds). */
function renderIdleStatus() {
  if (lastSyncAt) setDepStatus("neutral", `Synced ${relTime(new Date(lastSyncAt).toISOString())}`);
  else setDepStatus("pending", "Not synced yet");
}

/** Run a Dependabot sync: scan the notification-sourced repo list, store, and reload. Manages
 *  its own status chrome (independent of the Notifications sync). If a sync is already in
 *  flight (e.g. auto-sync + a manual click), queue exactly one follow-up. `syncing` stays true
 *  until the `finally` block so re-entrancy is reliably gated across the whole flow. */
export async function syncDependabot() {
  if (!isAuthenticated()) {
    setDepProgress("Connect a GitHub token to sync Bot PRs.", "error");
    return;
  }
  if (syncing) {
    pendingSync = true;
    return;
  }
  setDepBusy(true);
  syncing = true;
  setDepStatus("pending", "Syncing…");
  setDepProgress("Starting…");
  enqueueAnnounce("Bot PRs sync started.");
  try {
    const result = await invoke("sync_dependabot");
    lastSyncAt = Date.now();
    const removed = result.removed ?? 0;
    const msg = `Found ${result.count} PR${result.count === 1 ? "" : "s"}`;
    const detail = removed > 0 ? `${msg}, removed ${removed}.` : `${msg}.`;
    if (result.complete === false) {
      // Some repos couldn't be read (e.g. a 404 from a repo the token lacks PR access to) or
      // the scan stopped on the quota reserve. Surface it as a neutral note, not an error.
      setDepProgress(`${detail} Some repositories were skipped — check token access.`, "");
      enqueueAnnounce(`Sync partially complete. ${detail}`);
    } else {
      setDepProgress(detail, "success");
      enqueueAnnounce(`Sync complete. ${detail}`);
    }
    setDepStatus("success", "Synced just now");
    await loadDependabot();
  } catch (err) {
    setDepStatus("error", "Error");
    // GitHub's raw rate-limit 403 body is noisy; show a short, actionable message instead.
    const raw = String(err);
    const friendly = /rate limit/i.test(raw)
      ? "GitHub is rate-limiting requests right now. Wait a few minutes, then sync again."
      : raw;
    setDepProgress(friendly, "error");
    enqueueAnnounce("Bot PRs sync failed.");
  } finally {
    // Only now clear the in-flight flag — kept true through the UI updates + loadDependabot
    // above so a quick `r`/re-trigger can't start a concurrent sync.
    syncing = false;
    setDepBusy(false);
    // A trigger arrived mid-sync — run it now.
    if (pendingSync) {
      pendingSync = false;
      syncDependabot();
    }
  }
}

/** Called by main.js when the Bot PRs module becomes active: render cached PRs, then
 *  auto-sync if stale (never synced this session, or older than the staleness window). Also
 *  announces a concise summary of current operation state and any missed terminal transitions. */
export async function onDependabotOpened(context = {}) {
  if (context.trigger === "picker") kbdFocus.clear();
  await loadDependabot();
  if (context.trigger === "shortcut") focusFirstRow(true);
  if (context.trigger === "picker") focusFirstRow(false, true);
  announceReturnSummary();
  if (!isAuthenticated()) return;
  // Wait for the persisted last-sync time to load before the staleness gate, so restoring into
  // the Bot PRs module doesn't re-scan when a recent sync (from a previous run) is still
  // fresh — otherwise `lastSyncAt` would still be 0 here and we'd auto-sync every launch.
  await statusLoaded;
  if (!lastSyncAt || Date.now() - lastSyncAt > AUTO_SYNC_STALE_MS) {
    syncDependabot();
  }
}

function onDependabotClosed() {
  kbdFocus.clear();
  clearAnnounceQueue();
}

/* ---------------------------------- Init --------------------------------- */

/** Wire the Bot PRs module's DOM listeners + sync events. Call once on DOMContentLoaded. */
export function initDependabot() {
  const list = $("#dependabot");
  if (list) {
    list.addEventListener("click", onListClick);
    list.addEventListener("keydown", onListKeydown);
    list.addEventListener("scroll", closeMenu, true);
  }
  // List-kit: hover tracking (replaces inline mouseover/leave/scroll/blur wiring).
  hoverManager.wire();
  kbdFocus.wire();
  document.addEventListener("keydown", onCommandKeydown);
  $("#dependabot-sync-btn")?.addEventListener("click", syncDependabot);

  // Seed the last-sync time from persisted state so the "Synced …" label and the auto-sync
  // staleness gate survive app restarts. Best-effort: fall back to the neutral idle label.
  statusLoaded = invoke("dependabot_status")
    .then((status) => {
      const ts = status?.last_sync_at ? Date.parse(status.last_sync_at) : NaN;
      // Never move the clock backwards: a sync may have completed (setting lastSyncAt to
      // Date.now()) before this persisted read resolves.
      if (!Number.isNaN(ts)) lastSyncAt = Math.max(lastSyncAt, ts);
      renderIdleStatus();
    })
    .catch(() => renderIdleStatus());

  // Live progress during a sync (repos scanned / supported automation PRs found).
  listen("dependabot:progress", (event) => {
    if (!syncing) return;
    const { found } = event.payload ?? {};
    setDepProgress(`Scanning repositories… (${found ?? 0} found)`);
  });
  // Merge-readiness pills resolve in the background after a sync; reload once they land.
  listen("dependabot:resolved", () => {
    loadDependabot();
  });
  listen("dependabot:operations-changed", () => {
    reloadOperations();
  });
}

/* ─────────────────────────── Module registration ──────────────────────────── */

// Register as a module with lifecycle: activate runs the on-open logic (load + staleness-gated
// sync + missed-transition summary); deactivate clears stale announcement queues so queued
// operation/sync announcements don't fire after the user moves to another module.

registerModule("dependabot", {
  sidebarSelector: "#sidebar-dependabot",
  init: initDependabot,
  activate: onDependabotOpened,
  deactivate: onDependabotClosed,
  shortcuts: [
    {
      group: "Bot PRs",
      items: [
        { keys: ["j", "↓"], desc: "Next pull request" },
        { keys: ["k", "↑"], desc: "Previous pull request" },
        { keys: ["Enter"], desc: "Open in browser" },
        { keys: ["r"], desc: "Sync Bot PRs" },
      ],
    },
  ],
});
