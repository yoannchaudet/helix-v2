import { invoke } from "./api.js";
import { $, $$, html, rawHtml, toast, announce, copyText } from "./dom.js";
import {
  FILTERS,
  EMPTY_SUBTITLES,
  repoMatches,
  sortReposByRecency,
  filterGroups,
  filterGroupsByType,
  typeMatch,
  TYPE_FILTERS,
  notificationUrlsText,
} from "./inbox-model.js";
import { repoSection, typeFilterBar } from "./inbox-view.js";
import { SNOOZE_OPTIONS, SNOOZE_HINT, snoozeUntil } from "./snooze-model.js";
import { sourceButton } from "./ui.js";
import { openContextMenu, closeMenu, isMenuOpen, menuContains } from "./menu.js";
import { isAuthenticated } from "./account.js";
import {
  setSyncProgress,
  flashSyncProgress,
  loadSyncStatus,
  syncNow,
  registerSyncStaleListener,
} from "./sync.js";
import { showSettings } from "./settings.js";
import { isShortcutsOpen } from "./shortcuts.js";
import { registerModule, getActiveModule } from "./modules.js";
import {
  createHoverManager,
  createKbdFocusRing,
  createRowNavigator,
  createListFocusRetainer,
} from "./list-kit.js";
import { focusNeighborAfterRemoval } from "./list-kit-model.js";
import {
  applyRepoCollapseState,
  setRepoCollapsed,
  subscribeRepoCollapse,
} from "./repo-collapse.js";

/* The inbox: the notification list + its sidebar (type filters + repo refinement), keyboard
 * focus preservation across re-renders, the mark-done flows, and row interactions. Pure
 * row/section HTML lives in `inbox-view.js`; this module owns all state and DOM wiring. */

/* The sidebar drives two orthogonal selections: a single notification *type* filter (top
 * group, always exactly one active) and an optional *repository* refinement. Notifications
 * are fetched once into `inboxGroups` and re-rendered locally as either selection changes. */

let inboxGroups = [];
/** Bookmarked notifications (snapshot, independent of the inbox lifecycle), loaded
 *  alongside the inbox. Powers the "Bookmarks" filter and its sidebar count. */
let bookmarkGroups = [];
/** Currently-snoozed notifications (own snapshot, hidden from every other filter). Powers
 *  the "Snoozed" filter and its sidebar count. */
let snoozeGroups = [];
/** Active notification-type filter (always set); one of the FILTERS keys. */
let activeFilter = "all";
/** Optional repository refinement: a repo_id, or null for "all repositories". */
let activeRepo = null;
/** Selected subject-type buckets (top-of-view pills). All three on by default; at least
 *  one always stays selected. Pre-filters both datasets so the smart-filter counts, repo
 *  list, and main view all reflect the active type selection. Resets each launch. */
let selectedTypes = new Set(TYPE_FILTERS.map((t) => t.id));
/** Whether notifications should be reloaded next time the module becomes active. */
let inboxStale = true;

/** The dataset the active filter draws from: bookmarks and snoozed rows come from their own
 *  snapshots (so hidden/done ones still show); every other filter draws from the live inbox.
 *  The active type-pill selection pre-filters whichever dataset is chosen. */
let typeFilterMemo = { base: null, sig: "", result: null };
function currentGroups() {
  let base = inboxGroups;
  if (activeFilter === "bookmarked") base = bookmarkGroups;
  else if (activeFilter === "snoozed") base = snoozeGroups;
  // `selectedTypes` is mutated in place, so key the memo on its contents (not identity)
  // plus the base dataset reference (reassigned on reload).
  const sig = TYPE_FILTERS.map((t) => (selectedTypes.has(t.id) ? "1" : "0")).join("");
  if (typeFilterMemo.base !== base || typeFilterMemo.sig !== sig) {
    typeFilterMemo = { base, sig, result: filterGroupsByType(base, selectedTypes) };
  }
  return typeFilterMemo.result;
}

/** Apply the active filter, then the optional repo refinement, to the active dataset,
 *  ordering the repos most-recent-first. Thin wrapper binding the pure `filterGroups`. */
function filteredGroups() {
  return filterGroups(currentGroups(), activeFilter, activeRepo);
}

/** Current toolbar breadcrumb: the filter label, plus the repo when refined. */
function activeTitleHtml() {
  const label = (FILTERS[activeFilter] ?? FILTERS.all).label;
  if (activeRepo != null) {
    const group = currentGroups().find((g) => g.repo_id === activeRepo);
    if (group) {
      return html`${label}${rawHtml(
        html`<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${group.full_name}</span>`,
      )}`;
    }
  }
  return html`${label}`;
}

/** Plain-text accessible name for the breadcrumb (the visual `›` separator is
 *  hidden from assistive tech, so spell out the hierarchy in words here). */
function activeTitleLabel() {
  const label = (FILTERS[activeFilter] ?? FILTERS.all).label;
  if (activeRepo != null) {
    const group = currentGroups().find((g) => g.repo_id === activeRepo);
    if (group) return `${label}, repository ${group.full_name}`;
  }
  return label;
}

function emptyInbox() {
  if (!isAuthenticated()) {
    return html`<div class="inbox-empty">
        <p>Connect your GitHub account to start receiving notifications.</p>
        <button type="button" class="btn js-goto-settings">Open Settings</button>
      </div>`;
  }
  // Authenticated but nothing to show — either the inbox is genuinely empty or the active
  // filter has no matches. Reaching this is a small win, so show the muted helix mark with a
  // filter-specific subtitle (the toolbar already exposes sync status + refresh).
  const sub = EMPTY_SUBTITLES[activeFilter] ?? EMPTY_SUBTITLES.all;
  return html`<div class="inbox-empty">
      <img class="inbox-empty-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
      <p class="inbox-empty-title">You're all caught up.</p>
      <p class="inbox-empty-sub">${sub}</p>
    </div>`;
}

/* ------------------------------ Inbox focus ------------------------------ */

/* The inbox re-renders wholesale (filter changes, sync, mark-done), which would otherwise
 * drop keyboard focus to <body>. We capture where focus was, then restore it after the
 * new DOM is in place — either to an explicit target (set by mark-done, since the focused
 * row is gone) or back to the same row the user was on. */

/** An explicit focus target for the *next* render, e.g. after the focused row is removed.
 *  Shape: { threadId, part } | { selector }. Consumed (cleared) by the next renderInbox. */
let pendingInboxFocus = null;

/* Row hover is driven by a JS-managed class instead of the CSS `:hover` pseudo — see
 * list-kit.js for the full rationale (WKWebView re-render storms under a stationary cursor). */
const hoverManager = createHoverManager({
  containerSelector: "#inbox",
  rowHoverClass: "n-row--hover",
  headerHoverClass: "repo-header--hover",
});

/** Keyboard-selection ring: marks the focused row for programmatic/keyboard focus (mouse
 *  clicks use `:focus-visible`). Cleared on the next mouse interaction. */
const kbdFocus = createKbdFocusRing({ containerSelector: "#inbox" });

const inboxFocusRetainer = createListFocusRetainer({
  containerSelector: "#inbox",
  rowSelector: ".n-row",
  captureTarget: (row, active) => ({
    threadId: row.dataset.threadId,
    kbd: active.classList.contains("kbd-focus"),
    part: active.classList.contains("n-done") ? "done" : "open",
  }),
  matchRow: (row, target) => row.dataset.threadId === target.threadId,
  resolveElement: (row, target) => {
    // Prefer the part the user was on. Never fall back to the mark-as-done control for a
    // non-"done" target: focusing a `.n-done` reveals it via `:focus-visible`, and during the
    // background subject-resolution re-render storm that leaves stray mark-as-done checks on
    // unresolved rows (which have no openable `.n-open[tabindex]` to catch focus instead).
    const done = row.querySelector(".n-done");
    const open = row.querySelector(".n-open[tabindex]");
    return target.part === "done" ? done || open : open;
  },
});

/** Snapshot the inbox's current row focus so a re-render can restore it. */
function captureInboxFocus() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.classList.contains("repo-collapse")) {
    const repoId = Number(active.dataset.collapseRepo);
    if (Number.isFinite(repoId)) {
      return {
        selector: `.repo-collapse[data-collapse-repo="${repoId}"]`,
      };
    }
  }
  return inboxFocusRetainer.capture();
}

/** Apply a focus target within the freshly-rendered inbox. Returns true if it landed. */
function applyInboxFocus(target, { preventScroll = false } = {}) {
  if (!target) return false;
  if (target.selector) {
    const el = $(target.selector);
    if (!el) return false;
    kbdFocus.clear();
    el.focus({ preventScroll });
    return true;
  }
  const landed = inboxFocusRetainer.apply(target, { preventScroll });
  if (!landed) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (target.kbd) kbdFocus.apply(active);
    else kbdFocus.clear();
  }
  return true;
}

/** Pick where focus should land after `removedIds` are removed from the current view:
 *  the nearest surviving row after the removed block (else before it), or the inbox
 *  container when the view empties out. Call BEFORE mutating `inboxGroups`. */
function focusTargetAfterRemoval(removedIds) {
  const flat = visibleNotifications();
  const removedSet = new Set(removedIds);
  const active = document.activeElement;
  const kbd = active instanceof HTMLElement && active.classList.contains("kbd-focus");
  const survivor = focusNeighborAfterRemoval(flat, removedIds, (n) => n.thread_id);
  // None of the removed threads are in the current view (e.g. the list changed while a
  // confirm menu was open). Don't force focus anywhere — let renderInbox's preserved-focus
  // path keep the user where they are.
  if (survivor == null && !flat.some((n) => removedSet.has(n.thread_id))) return null;
  // Nothing left to focus in the list — keep focus in a sensible place by sending it to the
  // inbox container (made programmatically focusable in renderInbox's empty branch).
  if (!survivor) return { selector: "#inbox" };
  return { threadId: survivor.thread_id, part: "open", kbd };
}

/* ------------------------------- Rendering ------------------------------- */

/** Render the main list for the active filter (and optional repo refinement). */
function renderInbox() {
  const inbox = $("#inbox");
  const title = $("#view-title");
  title.innerHTML = activeTitleHtml();
  // The visual `›` is aria-hidden, so give the heading a spelled-out accessible name.
  title.setAttribute("aria-label", activeTitleLabel());
  // Decide the focus target before the DOM is swapped: an explicit pending target wins,
  // otherwise keep the user on the same row across the re-render.
  const preserved = captureInboxFocus();
  const focusTarget = pendingInboxFocus ?? preserved;
  pendingInboxFocus = null;
  const groups = filteredGroups();
  // The rows/headers we tracked for hover are about to be replaced — drop the markers so a
  // background re-render under a stationary cursor can't leave controls stuck-visible.
  hoverManager.clear();
  // The toolbar "mark all as done" only makes sense when the active filter shows something.
  const markAll = $("#mark-all-done-btn");
  if (markAll) markAll.disabled = !groups.length;
  if (!groups.length) {
    inbox.innerHTML = emptyInbox();
    const goto = inbox.querySelector(".js-goto-settings");
    if (goto) goto.addEventListener("click", () => showSettings(true));
    // If focus was in the list (explicit `#inbox` target, or a now-vanished row), park it
    // on the (now focusable) inbox container so keyboard focus isn't dropped to <body>.
    if (focusTarget) {
      inbox.tabIndex = -1;
      inbox.focus({ preventScroll: focusTarget === preserved });
    }
    reconcileArmedSnooze();
    return;
  }
  inbox.innerHTML = groups.map(repoSection).join("");
  // Restore focus. An explicit pending target may scroll into view; a passive "stay on the
  // same row" restore must not yank the scroll position during a background re-render.
  if (focusTarget) {
    const preventScroll = focusTarget === preserved;
    const landed = applyInboxFocus(focusTarget, { preventScroll });
    // The intended row is gone (e.g. removed by a background reconcile) — keep the user in the
    // list without landing on a row *control*. Focusing a `.n-done` here would reveal it via
    // `:focus-visible`, and during the background re-render storm that leaves stray mark-as-done
    // checks on unresolved rows. Prefer an openable row; otherwise park on the inbox container.
    if (!landed) {
      const open = inbox.querySelector(".n-open[tabindex]");
      if (open) {
        open.focus({ preventScroll });
      } else {
        inbox.tabIndex = -1;
        inbox.focus({ preventScroll });
      }
    }
  }
  reconcileArmedSnooze();
}

/* Inline-SVG icons for the sidebar smart filters (keyed by FILTERS id) and repositories.
 * Presentational only; kept here next to the sidebar that renders them. */
const FILTER_ICONS = {
  all: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l1.6 1.7L10.6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  mention: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M10.3 8a2.3 2.3 0 10-2.3 2.3M10.3 5.7v3a1.4 1.4 0 002.5.8A5.2 5.2 0 108 13.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  team_mention: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 12.5a3.5 3.5 0 017 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.4 4.2a2.2 2.2 0 010 4.1M11.2 12.5a3.5 3.5 0 00-1.3-2.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  review_requested: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="4" cy="4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="12" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 4H9a2 2 0 012 2v.4M4 5.6v4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  assign: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="5.2" r="2.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 13a4.5 4.5 0 019 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  cleanup: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M9.5 2.5l4 4-5.5 5.5H4v-4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M2.5 13.5h6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
  bookmarked: `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M4 2.5h8v11l-4-3-4 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  snoozed: `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5.5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

/** Render the static set of smart-filter buttons from FILTERS (in order), each with an
 *  empty `data-count` badge that `renderSidebar` populates live. Called once at init. */
function renderFilterList() {
  const list = $("#filter-list");
  if (!list) return;
  list.innerHTML = Object.entries(FILTERS)
    .map(([id, { label }]) =>
      sourceButton({
        icon: FILTER_ICONS[id] ?? "",
        label,
        attrs: html`data-filter="${id}"`,
        active: id === activeFilter,
        countKey: id,
      }),
    )
    .join("");
}

/** Update sidebar filter/repo selection styling + the smart-filter counts. */
function renderSidebar() {
  // Smart-filter counts are pre-filtered by the active type pills so they match the view.
  const all = inboxGroups
    .flatMap((g) => g.notifications)
    .filter((n) => typeMatch(n, selectedTypes));
  // Derive counts from FILTERS so adding/renaming a filter updates the sidebar in one place.
  const counts = Object.fromEntries(
    Object.entries(FILTERS).map(([id, { match }]) => [id, all.filter(match).length]),
  );
  // Bookmarks live in their own snapshot dataset (incl. done/removed), so count those —
  // also narrowed to the selected types.
  counts.bookmarked = bookmarkGroups
    .flatMap((g) => g.notifications)
    .filter((n) => typeMatch(n, selectedTypes)).length;
  // Snoozed rows are hidden from the live inbox, so they too come from their own dataset.
  counts.snoozed = snoozeGroups
    .flatMap((g) => g.notifications)
    .filter((n) => typeMatch(n, selectedTypes)).length;
  for (const el of $$("#filter-list .source-count[data-count]")) {
    const key = el.dataset.count;
    const value = counts[key] ?? 0;
    el.textContent = value ? String(value) : "";
  }

  // Repositories list — drawn from the active dataset, filtered to repos with matching
  // notifications, with counts that reflect that filter.
  const repoList = $("#repo-list");
  let visibleRepos = currentGroups()
    .map((g) => ({ group: g, matches: repoMatches(g, activeFilter) }))
    .filter((x) => x.matches.length);
  // Same most-recent-first ordering as the main list, so the sidebar matches the view.
  visibleRepos = sortReposByRecency(
    visibleRepos,
    (x) => x.matches,
    (x) => x.group.full_name,
  );
  if (!visibleRepos.length) {
    repoList.innerHTML = html`<li class="source-empty">No repositories yet.</li>`;
  } else {
    repoList.innerHTML = visibleRepos
      .map(({ group: g, matches }) =>
        sourceButton({
          icon: REPO_ICON,
          label: g.full_name,
          labelTitle: g.full_name,
          lock: g.private,
          className: "repo-source",
          attrs: html`data-repo="${g.repo_id}"`,
          // Total notifications matching the active filter in this repo (read state untracked).
          count: matches.length ? String(matches.length) : "",
        }),
      )
      .join("");
    for (const btn of repoList.querySelectorAll(".repo-source")) {
      btn.addEventListener("click", () => selectRepo(Number(btn.dataset.repo)));
    }
  }

  // Filter and repo are independent selections, so each is highlighted on its own.
  for (const btn of $$(".source[data-filter]")) {
    const active = btn.dataset.filter === activeFilter;
    btn.classList.toggle("source--active", active);
    // Expose the selection to assistive tech, not just via color.
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
  for (const btn of $$(".source[data-repo]")) {
    const active = activeRepo != null && Number(btn.dataset.repo) === activeRepo;
    btn.classList.toggle("source--active", active);
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** Choose the notification-type filter. Drops a repo refinement that no longer has
 *  any matching notifications under the new filter (per the agreed UX). */
function selectFilter(filterId, kbd = false) {
  activeFilter = filterId;
  if (activeRepo != null) {
    const group = currentGroups().find((g) => g.repo_id === activeRepo);
    if (!group || !repoMatches(group, activeFilter).length) activeRepo = null;
  }
  showSettings(false);
  renderSidebar();
  renderInbox();
  focusFirstRow(kbd);
  announceView();
}

/** Build the subject-type pill row once and wire each pill's click to `toggleType`.
 *  Called at init; thereafter the on/off styling is updated in place by `syncTypePills`. */
function renderTypeFilter() {
  const bar = $("#type-filter");
  if (!bar) return;
  bar.innerHTML = typeFilterBar(selectedTypes);
  for (const btn of bar.querySelectorAll(".type-pill")) {
    btn.addEventListener("click", () => toggleType(btn.dataset.type));
  }
}

/** Reflect the current `selectedTypes` on the existing pill buttons (class + aria) without
 *  replacing the nodes, so focus stays on the pill the user just activated. */
function syncTypePills() {
  for (const btn of $$("#type-filter .type-pill")) {
    const on = selectedTypes.has(btn.dataset.type);
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

/** Toggle a subject-type pill on/off. At least one bucket always stays selected, so
 *  clicking the last active pill is a no-op. After changing the selection, re-validate the
 *  repo refinement (a repo with no matching notifications under the new type+filter is
 *  cleared) and re-render the whole view so counts and the list track the change. */
function toggleType(typeId) {
  if (!selectedTypes.has(typeId)) {
    selectedTypes.add(typeId);
  } else {
    if (selectedTypes.size === 1) return; // Keep at least one type selected.
    selectedTypes.delete(typeId);
  }
  if (activeRepo != null) {
    const group = currentGroups().find((g) => g.repo_id === activeRepo);
    if (!group || !repoMatches(group, activeFilter).length) activeRepo = null;
  }
  syncTypePills();
  renderSidebar();
  renderInbox();
  announceView();
}

/** Toggle the repository refinement: select it, or clear it if already active. */
function selectRepo(repoId, kbd = false) {
  activeRepo = activeRepo === repoId ? null : repoId;
  showSettings(false);
  renderSidebar();
  renderInbox();
  focusFirstRow(kbd);
  announceView();
}

/** Move keyboard focus to the first notification row, so a freshly chosen filter/repo has a
 *  clear selection (and single-key commands like b/d/c act on a real row, not whatever last
 *  held focus). No-op when the view is empty. */
function focusFirstRow(kbd = true, force = false) {
  // Keep existing behavior for filter/repo clicks: only keyboard-driven intra-module actions
  // steal focus, unless a module-switch activation explicitly forces a reset target.
  if (!kbd && !force) return;
  const first = $("#inbox").querySelector(".n-row");
  if (first) focusRow(first, kbd);
}

/** Announce the current view (its spelled-out label + how many notifications it shows) to
 *  assistive tech, since the visual heading update isn't announced on its own. */
function announceView() {
  const count = visibleNotifications().length;
  const noun = count === 1 ? "notification" : "notifications";
  announce(`${activeTitleLabel()}, ${count} ${noun}.`);
}

function markInboxStale() {
  inboxStale = true;
  if (getActiveModule() === "notifications") {
    loadInbox();
  }
}

async function refreshInboxIfStale() {
  if (!inboxStale) return;
  await loadInbox();
}

async function onNotificationsOpened(context = {}) {
  if (context.trigger === "picker") kbdFocus.clear();
  await refreshInboxIfStale();
  if (context.trigger === "shortcut") focusFirstRow(true);
  if (context.trigger === "picker") focusFirstRow(false, true);
}

function onNotificationsClosed() {
  kbdFocus.clear();
  snoozeKeyHeld = false;
  snoozeHoldCancelled = false;
  disarmSnooze();
  clearSnoozeHint();
  // Don't reload (and re-render) a hidden module on a snooze expiry; mark it stale instead so
  // the deadline is re-evaluated when the user comes back.
  clearTimeout(snoozeWakeTimer);
  snoozeWakeTimer = null;
  if (snoozeGroups.length) inboxStale = true;
}

export async function loadInbox() {
  try {
    const [inbox, bookmarks, snoozed] = await Promise.all([
      invoke("list_inbox"),
      invoke("list_bookmarks"),
      invoke("list_snoozed"),
    ]);
    inboxGroups = applyRepoCollapseState(inbox);
    bookmarkGroups = applyRepoCollapseState(bookmarks);
    snoozeGroups = applyRepoCollapseState(snoozed);
    scheduleSnoozeWake();
    // Drop a repo refinement whose repository is no longer present in the active dataset.
    if (activeRepo != null && !currentGroups().some((g) => g.repo_id === activeRepo)) {
      activeRepo = null;
    }
    renderSidebar();
    renderInbox();
    // `isAuthenticated()` may still be false while account bootstrap is in flight. Keep the
    // module stale in that case so auth-driven re-activation can reload with resolved auth.
    inboxStale = !isAuthenticated();
  } catch (err) {
    inboxStale = true;
    $("#inbox").innerHTML = html`<pre class="error-detail">${err}</pre>`;
  }
}

/** Toggle a thread's bookmark, then reload so the inbox flag, the Bookmarks list, and the
 *  sidebar count all reflect the change. */
async function toggleBookmark(threadId, bookmark) {
  try {
    await invoke("set_bookmark", { threadId, bookmarked: bookmark });
    announce(bookmark ? "Bookmarked." : "Bookmark removed.");
  } catch (err) {
    setSyncProgress(String(err), "error");
  }
  await loadInbox();
}

/** Update one repository's collapse state across the live inbox and bookmark snapshots. */
function setRepoCollapsedInGroups(repoFullName, collapsed) {
  const update = (groups) =>
    groups.map((group) => (group.full_name === repoFullName ? { ...group, collapsed } : group));
  inboxGroups = update(inboxGroups);
  bookmarkGroups = update(bookmarkGroups);
  snoozeGroups = update(snoozeGroups);
  typeFilterMemo.base = null;
}

/** Optimistically toggle one repository section and persist the presentation preference. */
async function toggleRepoCollapsed(btn) {
  const repoId = Number(btn.dataset.collapseRepo);
  const repoFullName = btn.dataset.repoFullName;
  if (!repoFullName || !Number.isFinite(repoId)) return;

  const group = [...inboxGroups, ...bookmarkGroups].find((g) => g.full_name === repoFullName);
  if (!group) return;

  const collapsed = !Boolean(group.collapsed);
  pendingInboxFocus = {
    selector: `.repo-collapse[data-collapse-repo="${repoId}"]`,
  };

  try {
    const result = await setRepoCollapsed(repoFullName, collapsed);
    if (result.latest) {
      announce(`${repoFullName} notifications ${collapsed ? "collapsed" : "expanded"}.`);
    }
  } catch ({ error, latest }) {
    if (latest) {
      pendingInboxFocus = {
        selector: `.repo-collapse[data-collapse-repo="${repoId}"]`,
      };
      setSyncProgress(String(error), "error");
    }
  }
}

/* --------------------------------- Snooze --------------------------------- */

/** Pending reload timer for the next snooze expiry, so a woken notification reappears on
 *  time instead of waiting for the next poll. */
let snoozeWakeTimer = null;

/** (Re)arm the wake timer for the soonest active deadline. Clamped to at least a second (a
 *  deadline can be in the past between a load and its render) and capped at a minute, so a
 *  long snooze doesn't rely on one enormous, drift-prone timeout. */
function scheduleSnoozeWake() {
  clearTimeout(snoozeWakeTimer);
  snoozeWakeTimer = null;
  const deadlines = snoozeGroups
    .flatMap((g) => g.notifications)
    .map((n) => new Date(n.snoozed_until).getTime())
    .filter((t) => Number.isFinite(t));
  if (!deadlines.length) return;
  const delay = Math.min(Math.max(Math.min(...deadlines) - Date.now(), 1000), 60_000);
  snoozeWakeTimer = setTimeout(() => {
    snoozeWakeTimer = null;
    // A no-op reload if nothing actually expired; it also re-arms the timer.
    loadInbox();
  }, delay);
}

/** Hide a thread until `optionId`'s deadline, then reload so the inbox, the Snoozed list,
 *  and the sidebar counts all reflect it. Local-only — nothing is sent to GitHub. */
async function snoozeThread(threadId, optionId) {
  const untilAt = snoozeUntil(optionId);
  if (!untilAt) return;
  // Optimistic: drop the row locally so it disappears immediately, mirroring mark-done.
  const focusTarget = focusTargetAfterRemoval([threadId]);
  inboxGroups = inboxGroups
    .map((g) => ({ ...g, notifications: g.notifications.filter((n) => n.thread_id !== threadId) }))
    .filter((g) => g.notifications.length);
  if (activeRepo != null && !currentGroups().some((g) => g.repo_id === activeRepo)) {
    activeRepo = null;
  }
  renderSidebar();
  pendingInboxFocus = focusTarget;
  renderInbox();
  try {
    await invoke("set_snooze", { threadId, untilAt });
    announce(`Snoozed until ${new Date(untilAt).toLocaleString()}.`);
  } catch (err) {
    setSyncProgress(String(err), "error");
  }
  await loadInbox();
}

/** End a thread's snooze immediately and reload. */
async function unsnoozeThread(threadId) {
  try {
    await invoke("clear_snooze", { threadId });
    announce("Unsnoozed.");
  } catch (err) {
    setSyncProgress(String(err), "error");
  }
  await loadInbox();
}

/* --------------------------------- Mark done ------------------------------- */

/** Flatten the currently visible (filtered) notifications into a flat list. */
function visibleNotifications() {
  return filteredGroups().flatMap((g) => g.notifications);
}

/** Transient confirmation of how a done batch went, surfaced in the toolbar. */
function reportMutation(result, verb) {
  const failed = result.failed ?? [];
  if (failed.length) {
    // setSyncProgress cancels any pending "clear" timer from an earlier success so it
    // can't wipe this error message out from under the user.
    setSyncProgress(`${result.ok} ${verb}, ${failed.length} failed: ${failed[0].error}`, "error");
  } else if (result.ok > 0) {
    flashSyncProgress(`${result.ok} ${verb}.`, "success");
  }
}

/** Mark the given thread ids as done: optimistically remove them, call the backend, then
 *  reconcile from SQLite. */
async function markDone(threadIds) {
  if (!isAuthenticated()) {
    setSyncProgress("Connect a GitHub token to mark notifications as done.", "error");
    return;
  }
  const ids = [...new Set(threadIds)];
  if (!ids.length) return;
  // Where should focus go once these rows vanish? Compute against the current view before
  // we mutate it, so keyboard users aren't dropped to <body> when their row is removed.
  // Exception: in the Bookmarks filter the row doesn't vanish (it stays as a now-done
  // snapshot), so retargeting focus would be a jarring hop — keep the user on the same row.
  const focusTarget = activeFilter === "bookmarked" ? null : focusTargetAfterRemoval(ids);
  // Optimistic: drop the rows locally so they disappear immediately.
  const idSet = new Set(ids);
  inboxGroups = inboxGroups
    .map((g) => ({
      ...g,
      notifications: g.notifications.filter((n) => !idSet.has(n.thread_id)),
    }))
    .filter((g) => g.notifications.length);
  // If the refined repo just lost its last visible notification, clear the refinement so
  // renderInbox doesn't show the empty state while other repos still have notifications
  // (loadInbox would otherwise only fix this once the round-trip completes).
  if (activeRepo != null && !currentGroups().some((g) => g.repo_id === activeRepo)) {
    activeRepo = null;
  }
  renderSidebar();
  pendingInboxFocus = focusTarget;
  renderInbox();
  announce(
    ids.length === 1
      ? "Notification marked as done."
      : `${ids.length} notifications marked as done.`,
  );
  try {
    const result = await invoke("mark_threads_done", { threadIds: ids });
    reportMutation(result, "marked done");
  } catch (err) {
    // setSyncProgress cancels any pending "clear" timer so it can't wipe this error out
    // moments later.
    setSyncProgress(String(err), "error");
  }
  await loadSyncStatus();
  // The authoritative reload re-renders again. Only keep focus pinned through it if the
  // user is still in the list (they may have Tabbed away during the round-trip); pin to
  // wherever they actually are now so an arrow-key move since the optimistic render sticks.
  pendingInboxFocus = captureInboxFocus();
  await loadInbox();
}

/* ----------------------------- Interactions ------------------------------ */

/** Open a notification's subject in the default browser via the backend. */
function openNotification(url) {
  if (!url) return;
  invoke("open_url", { url }).catch((err) => {
    console.error(`failed to open ${url}: ${err}`);
    toast("Couldn't open link", "error");
  });
}

/** Copy notification subject URLs to the clipboard with consistent feedback. */
async function copyNotificationUrls(text, multiple = false) {
  if (!text) return;
  if (await copyText(text)) {
    toast(multiple ? "Copied URLs" : "Copied URL");
  } else {
    console.error(`failed to copy notification URL${multiple ? "s" : ""}`);
    toast("Copy failed", "error");
  }
}

/** Copy one notification's subject URL to the clipboard. */
function copyNotificationUrl(url) {
  return copyNotificationUrls(url);
}

/** Resolve the `.n-row` an inbox event landed on, normalizing text-node targets. */
function inboxRowFromEvent(e) {
  const el = e.target instanceof Element ? e.target : e.target?.parentElement;
  return el?.closest(".n-row") ?? null;
}

/** Left-click an openable notification row → open it in the browser. */
function onInboxClick(e) {
  // Ignore the second click of a double-click so an instinctive double-click on a
  // desktop list row doesn't open two browser tabs.
  if (e.detail > 1) return;
  // Per-row bookmark toggle — local-only, never opens the row.
  const bookmarkBtn = e.target.closest?.(".n-bookmark");
  if (bookmarkBtn) {
    const row = bookmarkBtn.closest(".n-row");
    if (row?.dataset.threadId) {
      toggleBookmark(row.dataset.threadId, !bookmarkBtn.classList.contains("is-on"));
    }
    return;
  }
  // Per-row "unsnooze" — return a snoozed thread to the inbox now, without opening it.
  const unsnoozeBtn = e.target.closest?.(".n-unsnooze");
  if (unsnoozeBtn) {
    const row = unsnoozeBtn.closest(".n-row");
    if (row?.dataset.threadId) unsnoozeThread(row.dataset.threadId);
    return;
  }
  // Per-row "mark as done" — clear this thread instantly, without opening the row.
  const doneBtn = e.target.closest?.(".n-done");
  if (doneBtn) {
    const row = doneBtn.closest(".n-row");
    if (row?.dataset.threadId) markDone([row.dataset.threadId]);
    return;
  }
  // Persistent per-repository presentation toggle.
  const collapseBtn = e.target.closest?.(".repo-collapse");
  if (collapseBtn) {
    toggleRepoCollapsed(collapseBtn);
    return;
  }
  // Per-repo "mark all as done" for this repo (confirmed first).
  const repoBtn = e.target.closest?.(".repo-done");
  if (repoBtn) {
    confirmRepoDone(repoBtn);
    return;
  }
  const row = inboxRowFromEvent(e);
  if (row) {
    const open = row.querySelector(".n-open");
    if (open?.dataset.url) openNotification(open.dataset.url);
  }
}

/** Enter on a focused openable row → open it (links activate on Enter, not Space). */
function onInboxKeydown(e) {
  if (e.key !== "Enter") return;
  // Let the per-row / per-repo action buttons handle their own activation; don't also
  // open the row underneath them.
  if (e.target.closest?.(".n-done, .repo-done, .repo-collapse, .n-bookmark, .n-unsnooze")) return;
  const open = e.target.closest?.(".n-open");
  if (!open?.dataset.url) return;
  e.preventDefault();
  openNotification(open.dataset.url);
}

/* ----------------------- Keyboard command model -------------------------- */

/* Single-key triage shortcuts for power users (j/k navigate, d/e done, c copy, b bookmark,
 * s snooze, r sync, 1–8 filter). These layer on TOP of the existing Tab + Enter a11y (they
 * don't replace it): j/k just move focus among the row anchors so the list is fast without
 * Tabbing.
 *
 * `s` is a two-key chord rather than a single key because there are five durations to pick
 * from and the bare digits are already the filter switcher: `s` arms the chord (showing the
 * digit legend in the toolbar), and the next digit picks the duration. */

/** A row's primary focus target: its openable link, else its (revealed-on-focus) done
 *  button — so every row, openable or not, has a keyboard anchor. Marks the target with
 *  the kbd-focus ring so the selection shows for programmatic/keyboard focus. */
function focusRow(row, kbd = true) {
  const target = row.querySelector(".n-open[tabindex]") || row.querySelector(".n-done");
  if (!target) return;
  if (kbd) kbdFocus.apply(target);
  else kbdFocus.clear();
  target.focus();
}

/** Shared row navigator (j/k movement, activeRow, rows). */
const nav = createRowNavigator({
  containerSelector: "#inbox",
  rowSelector: ".n-row",
  focusRow,
});

function markActiveRowDone() {
  const row = nav.activeRow();
  // A done row (only in Bookmarks) can't be marked done again — its button is already gone.
  if (row?.dataset.threadId && row.dataset.done !== "true") markDone([row.dataset.threadId]);
}

function copyActiveRowUrl() {
  const url = nav.activeRow()?.querySelector(".n-open")?.dataset.url;
  if (url) copyNotificationUrl(url);
}

/* The `s` snooze chord works two ways on purpose, because both are natural and users mix
 * them mid-flow:
 *   - tapped: `s`, release, then a digit
 *   - held:   `s` held down as a modifier while tapping digits
 * Both resolve through the same armed state, which stores a *thread id captured at arm time*
 * rather than reading focus when the digit lands. That matters because snoozing re-renders
 * the list, and a re-render can park focus on the `#inbox` container instead of a row — at
 * which point a focus-reading chord silently does nothing. */

/** The thread an armed `s` chord will snooze — while set, the next digit picks a duration
 *  instead of switching filters.
 *
 *  Deliberately has NO timeout: a chord that expired on its own would silently hand the next
 *  digit to the filter switcher, which is exactly the surprise this shortcut must avoid. The
 *  toolbar legend is the armed indicator, and any key or click resolves or cancels it. */
let armedSnooze = null;

/** Whether the physical `s` key is down right now. Holding it keeps the chord re-arming
 *  after each snooze, so a burst of digits snoozes a burst of rows. */
let snoozeKeyHeld = false;

/** Set when the chord is cancelled while `s` is still physically down. The modifier stays
 *  suppressed — swallowing digits so they can't jump filters, but snoozing nothing — until
 *  the key is released. */
let snoozeHoldCancelled = false;

/** Whether the toolbar is currently showing the digit legend, so clearing it can't wipe out
 *  an unrelated message (a sync error, say) that landed in the meantime. */
let snoozeHintShown = false;

function showSnoozeHint() {
  snoozeHintShown = true;
  setSyncProgress(SNOOZE_HINT, "pending");
}

function clearSnoozeHint() {
  if (!snoozeHintShown) return;
  snoozeHintShown = false;
  // Only blank the toolbar if it's still showing OUR text: an unrelated message (a sync
  // error, say) may have replaced the legend in the meantime and must survive.
  const showingHint = [...$$(".js-sync-progress")].some((el) => el.textContent === SNOOZE_HINT);
  if (showingHint) setSyncProgress("");
}

/** Report the outcome of a chord that couldn't do what the user asked. Replaces the legend,
 *  because a silently swallowed key is worse than a wrong one. */
function reportSnooze(message) {
  snoozeHintShown = false;
  flashSyncProgress(message, "");
}

/** The row under the keyboard cursor, if it's something a snooze can act on. */
function snoozeableRowId() {
  const row = nav.activeRow();
  // A done row (only in Bookmarks) is already hidden for good; snoozing it is meaningless.
  if (!row?.dataset.threadId || row.dataset.done === "true" || row.dataset.snoozedUntil) {
    return null;
  }
  return row.dataset.threadId;
}

/** Point the chord at a thread and show the digit legend. `viaHold` marks an arm that only
 *  exists because `s` is being held down, so releasing `s` takes it away again (otherwise a
 *  burst of held snoozes would leave a live chord behind to eat the user's next digit). */
function armSnoozeFor(threadId, viaHold = false) {
  armedSnooze = { threadId, viaHold };
  // Same handler + capture flag every time, so this can't stack up duplicate listeners.
  document.addEventListener("pointerdown", onPointerDownWhileArmed, true);
  showSnoozeHint();
}

/** Cancel the chord outright: drop the arm, drop the legend, and suppress the held-key
 *  modifier until `s` is released. */
function cancelSnooze() {
  disarmSnooze();
  clearSnoozeHint();
  if (snoozeKeyHeld) snoozeHoldCancelled = true;
}

/** Drop the armed chord. */
function disarmSnooze() {
  if (!armedSnooze) return;
  document.removeEventListener("pointerdown", onPointerDownWhileArmed, true);
  armedSnooze = null;
}

/** Any click means the user moved on (and may be about to click a sidebar filter), so the
 *  chord shouldn't outlive it. */
function onPointerDownWhileArmed() {
  cancelSnooze();
}

/** Releasing `s` ends the modifier form. It does NOT disarm: the tapped form (press `s`,
 *  release, then a digit) lives entirely after the keyup. */
function onSnoozeKeyUp(e) {
  if (e.key !== "s") return;
  snoozeKeyHeld = false;
  snoozeHoldCancelled = false;
  if (!armedSnooze || armedSnooze.viaHold) {
    disarmSnooze();
    clearSnoozeHint();
  }
}

/** A chord must not survive losing the window: the keyup would land somewhere else, leaving
 *  the modifier stuck on and a live chord waiting to eat the first digit typed on return. */
function onWindowBlurWhileSnoozing() {
  snoozeKeyHeld = false;
  snoozeHoldCancelled = false;
  disarmSnooze();
  clearSnoozeHint();
}

/** `s` on the row under the keyboard cursor: unsnooze it if it's snoozed, otherwise arm the
 *  chord so the next digit picks a duration. */
function snoozeActiveRow() {
  const row = nav.activeRow();
  const threadId = row?.dataset.threadId;
  // Nothing to snooze: say so rather than no-op silently, otherwise the user goes on to
  // press a digit that lands on the filter switcher instead.
  if (!threadId) {
    reportSnooze("Select a notification first (j / k).");
    return;
  }
  if (row.dataset.done === "true") {
    reportSnooze("That notification is already done.");
    return;
  }
  if (row.dataset.snoozedUntil) {
    disarmSnooze();
    clearSnoozeHint();
    unsnoozeThread(threadId);
    return;
  }
  armSnoozeFor(threadId);
  announce(SNOOZE_HINT);
}

/** A background reload can remove the captured row out from under an armed chord (marked
 *  done elsewhere, resolved, filtered away). Retire the chord rather than let a digit fire a
 *  backend call that silently no-ops on a thread that isn't there any more. Called after
 *  every inbox render. */
function reconcileArmedSnooze() {
  if (!armedSnooze) return;
  if (nav.rows().some((row) => row.dataset.threadId === armedSnooze.threadId)) return;
  disarmSnooze();
  clearSnoozeHint();
}

/** Keep an armed chord pointed at the row the cursor is actually on, so navigating with j/k
 *  mid-chord snoozes what the user is looking at. */
function retargetSnoozeAfterMove() {
  if (!armedSnooze && !snoozeKeyHeld) return;
  const threadId = snoozeableRowId();
  if (threadId) armSnoozeFor(threadId, armedSnooze ? armedSnooze.viaHold : true);
  else {
    disarmSnooze();
    clearSnoozeHint();
  }
}

/** Resolve the chord with the pressed digit. Returns false when the digit isn't one of the
 *  offered durations or there's no thread to act on, so the caller can report it. */
function resolveArmedSnooze(digit) {
  const option = SNOOZE_OPTIONS[digit - 1];
  // While `s` is held the chord may have been consumed by the previous digit; fall back to
  // whatever the cursor is on now.
  const threadId = option
    ? (armedSnooze?.threadId ?? (snoozeHoldCancelled ? null : snoozeableRowId()))
    : null;
  if (!threadId) return false;
  disarmSnooze();
  clearSnoozeHint();
  // Synchronous up to its first await: the list re-renders and moves the cursor on before
  // this returns, so the re-arm below lands on the *next* row.
  snoozeThread(threadId, option.id);
  // Holding `s` means "I'm snoozing a run of these" — re-arm so the next digit keeps working
  // instead of falling through to the filter switcher.
  if (snoozeKeyHeld) {
    const next = snoozeableRowId();
    if (next) armSnoozeFor(next, true);
  }
  return true;
}

/** Toggle the bookmark on the row under the keyboard cursor. */
function bookmarkActiveRow() {
  const btn = nav.activeRow()?.querySelector(".n-bookmark");
  if (btn) {
    const row = btn.closest(".n-row");
    if (row?.dataset.threadId) {
      toggleBookmark(row.dataset.threadId, !btn.classList.contains("is-on"));
    }
  }
}

/** Global triage keydown: active only on the notifications pane, with no modifier held,
 *  not while typing, and not while a menu/overlay owns the keyboard. */
function onCommandKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable)) {
    return;
  }
  if (isMenuOpen() || isShortcutsOpen()) return;
  if ($("#view-notifications")?.hidden) return;

  switch (e.key) {
    case "j":
    case "ArrowDown":
      e.preventDefault();
      nav.moveActiveRow(1);
      retargetSnoozeAfterMove();
      return;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      nav.moveActiveRow(-1);
      retargetSnoozeAfterMove();
      return;
    case "d":
    case "e":
      markActiveRowDone();
      return;
    case "c":
      copyActiveRowUrl();
      return;
    case "b":
      bookmarkActiveRow();
      return;
    case "s":
      e.preventDefault();
      snoozeKeyHeld = true;
      // Auto-repeat from holding `s` down mustn't re-announce the legend on every tick.
      if (e.repeat) return;
      snoozeHoldCancelled = false;
      snoozeActiveRow();
      return;
    case "r":
      e.preventDefault();
      syncNow();
      return;
  }

  // With the snooze chord armed (or `s` held as a modifier), a digit picks the duration
  // instead of switching filters. Every digit is consumed here, even one with no matching
  // duration, so a mistyped chord can never fall through and switch filters behind the
  // user's back — and an unresolvable one says why rather than doing nothing.
  if (armedSnooze || snoozeKeyHeld) {
    const isDigit = e.key >= "1" && e.key <= "9";
    if (isDigit || e.key === "Escape") e.preventDefault();
    if (isDigit && resolveArmedSnooze(Number(e.key))) return;
    const suppressed = snoozeHoldCancelled;
    cancelSnooze();
    if (isDigit) {
      reportSnooze(
        suppressed
          ? "Snooze cancelled — release s first."
          : SNOOZE_OPTIONS[Number(e.key) - 1]
            ? "Select a notification first (j / k)."
            : `${e.key} isn't a snooze duration (1–${SNOOZE_OPTIONS.length}).`,
      );
      return;
    }
    if (e.key === "Escape") return;
  }

  // 1–8 select a smart filter by position (FILTERS insertion order).
  if (e.key >= "1" && e.key <= "9") {
    const ids = Object.keys(FILTERS);
    const idx = Number(e.key) - 1;
    if (idx < ids.length) {
      e.preventDefault();
      selectFilter(ids[idx], true);
    }
  }
}

/** Confirm + mark all of one repo's (filtered) notifications done, from its header icon.
 *  Skips already-done rows (only present in the Bookmarks filter). */
function confirmRepoDone(btn) {
  const repoId = Number(btn.dataset.doneRepo);
  const group = filteredGroups().find((g) => g.repo_id === repoId);
  const ids = group ? group.notifications.filter((n) => !n.is_done).map((n) => n.thread_id) : [];
  confirmDone(ids, btn);
}

/** Resolve the repository id represented by an element inside a rendered repo section. */
function repoIdForElement(el) {
  const labelled = el.closest(".repo-section")?.getAttribute("aria-labelledby");
  return labelled ? Number(labelled.slice("repo-h-".length)) : NaN;
}

/** Web URL for a row's repository. Every notification belongs to a repo, so this works even
 *  for subjects with no resolvable link (e.g. Copilot agent sessions). github.com is the
 *  app's only host (see `API_BASE` in github.rs); `full_name` is `owner/repo`. */
function repoUrlForRow(row) {
  const group = currentGroups().find((g) => g.repo_id === repoIdForElement(row));
  if (!group) return null;
  return `https://github.com/${group.full_name.split("/").map(encodeURIComponent).join("/")}`;
}

/** Right-click a repository header → copy its filtered notifications' available URLs. */
function openRepoContextMenu(header, x, y) {
  const group = filteredGroups().find((g) => g.repo_id === repoIdForElement(header));
  if (!group) return;
  const text = notificationUrlsText(group.notifications);
  openContextMenu(x, y, [
    {
      label: "Copy notification URLs",
      disabled: !text,
      action: () => copyNotificationUrls(text, text.includes("\n")),
    },
  ]);
}

/** Right-click a repository header or notification row for the relevant actions. */
function onInboxContextMenu(e) {
  const target = e.target instanceof Element ? e.target : e.target?.parentElement;
  const header = target?.closest(".repo-header");
  if (header) {
    e.preventDefault();
    let { clientX: x, clientY: y } = e;
    if (x === 0 && y === 0) {
      const r = header.getBoundingClientRect();
      x = r.left + 12;
      y = r.bottom - 8;
    }
    openRepoContextMenu(header, x, y);
    return;
  }
  const row = inboxRowFromEvent(e);
  if (!row) return;
  e.preventDefault();
  const threadId = row.dataset.threadId;
  if (!threadId) return;
  const url = row.querySelector(".n-open")?.dataset.url;
  const repoUrl = repoUrlForRow(row);
  // A keyboard-triggered context menu (Menu key / Shift+F10) reports 0,0; anchor the
  // menu to the row instead so it doesn't appear detached in the corner.
  let { clientX: x, clientY: y } = e;
  if (x === 0 && y === 0) {
    const r = row.getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom - 8;
  }
  const isOn = row.querySelector(".n-bookmark")?.classList.contains("is-on");
  const snoozedUntil = row.dataset.snoozedUntil;
  const items = [
    {
      label: "Copy URL",
      disabled: !url,
      action: () => copyNotificationUrl(url),
    },
    {
      // Always available — useful for subjects with no link of their own.
      label: "Open repository",
      disabled: !repoUrl,
      action: () => openNotification(repoUrl),
    },
    { separator: true },
    {
      label: isOn ? "Remove bookmark" : "Bookmark",
      action: () => toggleBookmark(threadId, !isOn),
    },
  ];
  // Snooze is a "come back later" verb, so it's meaningless on an already-done row (which
  // only ever appears in Bookmarks) — and such a row can't be marked done again either. A
  // row that's currently snoozed gets the inverse action instead.
  if (row.dataset.done !== "true") {
    items.push(
      snoozedUntil
        ? { label: "Unsnooze", action: () => unsnoozeThread(threadId) }
        : {
            label: "Snooze",
            submenu: SNOOZE_OPTIONS.map(({ id, label }) => ({
              label,
              action: () => snoozeThread(threadId, id),
            })),
          },
      {
        label: "Mark as done",
        danger: true,
        action: () => markDone([threadId]),
      },
    );
  }
  openContextMenu(x, y, items);
}

/** In-app confirm popover for a destructive bulk mark-done, anchored under `anchorEl`.
 *  WKWebView (Tauri on macOS) doesn't implement window.confirm — it returns false without
 *  showing a dialog — so we confirm with the in-app menu, which actually works. */
function confirmDone(ids, anchorEl) {
  const n = ids.length;
  if (!n) return;
  const rect = anchorEl.getBoundingClientRect();
  openContextMenu(rect.left, rect.bottom + 4, [
    {
      label: `Confirm: mark ${n} as done (clears on GitHub)`,
      danger: true,
      action: () => markDone(ids),
    },
    { label: "Cancel", action: () => {} },
  ]);
}

/* ---------------------------------- Init --------------------------------- */

/** Wire all inbox DOM listeners (row actions, sidebar filters, the bulk-done popover and
 *  its dismissal). Call once on DOMContentLoaded. `loadInbox()` then fetches + renders. */
export function initInbox() {
  registerSyncStaleListener("notifications", markInboxStale);
  subscribeRepoCollapse((repoFullName, collapsed) => {
    setRepoCollapsedInGroups(repoFullName, collapsed);
    renderInbox();
  });
  // Render the smart-filter buttons (data-driven from FILTERS) before wiring their clicks.
  renderFilterList();
  // Sidebar smart filters.
  for (const btn of $$(".source[data-filter]")) {
    btn.addEventListener("click", () => selectFilter(btn.dataset.filter));
  }
  // Subject-type pills (Pull requests / Issues / Other); renders + wires its own clicks.
  renderTypeFilter();

  // Notification actions: left-click an (openable) row to open it in the browser,
  // right-click for the row menu, ••• for the visible set. Enter opens a focused row.
  $("#inbox").addEventListener("click", onInboxClick);
  $("#inbox").addEventListener("keydown", onInboxKeydown);
  $("#inbox").addEventListener("contextmenu", onInboxContextMenu);
  // List-kit: hover tracking + keyboard focus ring (replaces inline implementations).
  hoverManager.wire();
  kbdFocus.wire();
  // Power-user triage shortcuts (j/k/d/e/c/r/1–6) — global so filter/sync keys work from
  // anywhere on the notifications pane, not just when a row has focus.
  document.addEventListener("keydown", onCommandKeydown);
  document.addEventListener("keyup", onSnoozeKeyUp);
  window.addEventListener("blur", onWindowBlurWhileSnoozing);
  $("#mark-all-done-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    // Toggle: a second click on the trigger closes the open confirm popover.
    if (isMenuOpen()) {
      closeMenu();
      return;
    }
    const btn = e.currentTarget;
    confirmDone(
      visibleNotifications()
        .filter((n) => !n.is_done)
        .map((n) => n.thread_id),
      btn,
    );
    // Reflect the expanded state for assistive tech (closeMenu resets it). Only when the
    // popover actually opened (confirmDone no-ops on an empty set).
    if (isMenuOpen()) btn.setAttribute("aria-expanded", "true");
  });
  // Dismiss the popover on any outside click or scroll. Ignore the trigger itself — its own
  // click handler toggles the popover, and closing here first (mousedown precedes click)
  // would let the click immediately reopen it, making it impossible to close.
  document.addEventListener("mousedown", (e) => {
    const onTrigger = e.target.closest?.("#mark-all-done-btn");
    if (isMenuOpen() && !menuContains(e.target) && !onTrigger) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
  $("#inbox").addEventListener("scroll", closeMenu, true);
}

/* ─────────────────────────── Module registration ──────────────────────────── */

// Register this module's lifecycle and keyboard shortcuts with the module system.
// Initial + refresh loading is handled via activate (refreshInboxIfStale), so module
// ownership stays local instead of app-shell wiring.

registerModule("notifications", {
  sidebarSelector: "#sidebar-notifications",
  init: initInbox,
  activate: onNotificationsOpened,
  deactivate: onNotificationsClosed,
  shortcuts: [
    {
      group: "Navigation",
      items: [
        { keys: ["j", "↓"], desc: "Next notification" },
        { keys: ["k", "↑"], desc: "Previous notification" },
        { keys: ["Enter"], desc: "Open in browser" },
      ],
    },
    {
      group: "Triage",
      items: [
        { keys: ["d", "e"], desc: "Mark as done" },
        { keys: ["c"], desc: "Copy link" },
        { keys: ["b"], desc: "Bookmark / unbookmark" },
        { keys: ["s", "1–5"], desc: "Snooze (1 = 20 min … 5 = next week) / unsnooze" },
        { keys: ["r"], desc: "Sync now" },
      ],
    },
    {
      group: "Filters",
      items: [{ keys: ["1"], desc: "Switch smart filter (1 = All … 8 = Snoozed)" }],
    },
  ],
});
