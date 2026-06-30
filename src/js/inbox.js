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
} from "./inbox-model.js";
import { repoSection, typeFilterBar } from "./inbox-view.js";
import { sourceButton } from "./ui.js";
import { openContextMenu, closeMenu, isMenuOpen, menuContains } from "./menu.js";
import { isAuthenticated } from "./account.js";
import { setSyncProgress, flashSyncProgress, loadSyncStatus, syncNow } from "./sync.js";
import { showSettings } from "./settings.js";
import { isShortcutsOpen } from "./shortcuts.js";

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
/** Active notification-type filter (always set); one of the FILTERS keys. */
let activeFilter = "all";
/** Optional repository refinement: a repo_id, or null for "all repositories". */
let activeRepo = null;
/** Selected subject-type buckets (top-of-view pills). All three on by default; at least
 *  one always stays selected. Pre-filters both datasets so the smart-filter counts, repo
 *  list, and main view all reflect the active type selection. Resets each launch. */
let selectedTypes = new Set(TYPE_FILTERS.map((t) => t.id));

/** The dataset the active filter draws from: bookmarks come from their own snapshot (so
 *  done/removed ones still show); every other filter draws from the live inbox. The active
 *  type-pill selection pre-filters whichever dataset is chosen. */
let typeFilterMemo = { base: null, sig: "", result: null };
function currentGroups() {
  const base = activeFilter === "bookmarked" ? bookmarkGroups : inboxGroups;
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

/** Snapshot the inbox's current focus so a re-render can restore it. Returns null when
 *  focus isn't inside the inbox (so background re-renders never steal focus). */
function captureInboxFocus() {
  const active = document.activeElement;
  const inbox = $("#inbox");
  if (!active || !inbox || !inbox.contains(active)) return null;
  const row = active.closest(".n-row");
  if (!row) return null;
  return {
    threadId: row.dataset.threadId,
    part: active.classList.contains("n-done") ? "done" : "open",
  };
}

/** Apply a focus target within the freshly-rendered inbox. Returns true if it landed. */
function applyInboxFocus(target, { preventScroll = false } = {}) {
  if (!target) return false;
  const inbox = $("#inbox");
  if (!inbox) return false;
  if (target.selector) {
    const el = $(target.selector);
    if (el) {
      el.focus({ preventScroll });
      return true;
    }
    return false;
  }
  // Escape `"`/`\` for use inside the double-quoted attribute selector.
  const safeId = String(target.threadId).replace(/["\\]/g, "\\$&");
  const row = inbox.querySelector(`.n-row[data-thread-id="${safeId}"]`);
  if (!row) return false;
  // Prefer the part the user was on; fall back to whichever focusable the row has.
  const done = row.querySelector(".n-done");
  const open = row.querySelector(".n-open[tabindex]");
  const el = target.part === "done" ? done || open : open || done;
  if (!el) return false;
  el.focus({ preventScroll });
  return true;
}

/** Pick where focus should land after `removedIds` are removed from the current view:
 *  the nearest surviving row after the removed block (else before it), or the inbox
 *  container when the view empties out. Call BEFORE mutating `inboxGroups`. */
function focusTargetAfterRemoval(removedIds) {
  const removed = new Set(removedIds);
  const flat = visibleNotifications();
  const firstRemoved = flat.findIndex((n) => removed.has(n.thread_id));
  // None of the removed threads are in the current view (e.g. the list changed while a
  // confirm menu was open). Don't force focus anywhere — let renderInbox's preserved-focus
  // path keep the user where they are.
  if (firstRemoved === -1) return null;
  const after = flat.slice(firstRemoved + 1).find((n) => !removed.has(n.thread_id));
  const before = [...flat.slice(0, firstRemoved)]
    .reverse()
    .find((n) => !removed.has(n.thread_id));
  const survivor = after || before;
  // Nothing left to focus in the list — keep focus in a sensible place by sending it to the
  // inbox container (made programmatically focusable in renderInbox's empty branch).
  if (!survivor) return { selector: "#inbox" };
  return { threadId: survivor.thread_id, part: "open" };
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
    return;
  }
  inbox.innerHTML = groups.map(repoSection).join("");
  // Restore focus. An explicit pending target may scroll into view; a passive "stay on the
  // same row" restore must not yank the scroll position during a background re-render.
  if (focusTarget) {
    const preventScroll = focusTarget === preserved;
    const landed = applyInboxFocus(focusTarget, { preventScroll });
    // The intended row is gone (e.g. removed by a background reconcile) — keep the user in
    // the list on the first row rather than dropping focus to <body>.
    if (!landed) {
      inbox
        .querySelector(".n-open[tabindex], .n-done")
        ?.focus({ preventScroll });
    }
  }
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
  for (const el of $$(".source-count")) {
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
function focusFirstRow(kbd = true) {
  // Only steal focus for keyboard-driven switches; a mouse selection leaves focus alone so
  // no ring is painted.
  if (!kbd) return;
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

export async function loadInbox() {
  try {
    const [inbox, bookmarks] = await Promise.all([
      invoke("list_inbox"),
      invoke("list_bookmarks"),
    ]);
    inboxGroups = inbox;
    bookmarkGroups = bookmarks;
    // Drop a repo refinement whose repository is no longer present in the active dataset.
    if (activeRepo != null && !currentGroups().some((g) => g.repo_id === activeRepo)) {
      activeRepo = null;
    }
    renderSidebar();
    renderInbox();
  } catch (err) {
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

/* -------------------------------- Mark done ------------------------------- */

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
    setSyncProgress(
      `${result.ok} ${verb}, ${failed.length} failed: ${failed[0].error}`,
      "error",
    );
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
  const focusTarget =
    activeFilter === "bookmarked" ? null : focusTargetAfterRemoval(ids);
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

/** Copy a notification's subject URL to the clipboard. */
async function copyNotificationUrl(url) {
  if (!url) return;
  if (await copyText(url)) {
    toast("Copied URL");
  } else {
    console.error(`failed to copy ${url}`);
    toast("Copy failed", "error");
  }
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
  // Per-row "mark as done" — clear this thread instantly, without opening the row.
  const doneBtn = e.target.closest?.(".n-done");
  if (doneBtn) {
    const row = doneBtn.closest(".n-row");
    if (row?.dataset.threadId) markDone([row.dataset.threadId]);
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
  if (e.target.closest?.(".n-done, .repo-done, .n-bookmark")) return;
  const open = e.target.closest?.(".n-open");
  if (!open?.dataset.url) return;
  e.preventDefault();
  openNotification(open.dataset.url);
}

/* ----------------------- Keyboard command model -------------------------- */

/* Single-key triage shortcuts for power users (j/k navigate, d/e done, c copy, b bookmark,
 * r sync, 1–7 filter). These layer on TOP of the existing Tab + Enter a11y (they don't
 * replace it): j/k just move focus among the row anchors so the list is fast without Tabbing. */

/** All notification rows currently in the DOM, in visual order. */
function inboxRows() {
  return [...$("#inbox").querySelectorAll(".n-row")];
}

/** The row the keyboard "cursor" is on: whichever row contains focus, or null. */
function activeRow() {
  const el = document.activeElement;
  return el instanceof HTMLElement ? el.closest("#inbox .n-row") : null;
}

/** A row's primary focus target: its openable link, else its (revealed-on-focus) done
 *  button — so every row, openable or not, has a keyboard anchor. Marks the target with
 *  `kbd-focus` so the selection ring shows for programmatic/keyboard focus (mouse clicks use
 *  `:focus-visible`, which stays clean); the ring is cleared on the next mouse interaction. */
function focusRow(row, kbd = true) {
  const target = row.querySelector(".n-open[tabindex]") || row.querySelector(".n-done");
  if (!target) return;
  clearKbdFocus();
  if (kbd) target.classList.add("kbd-focus");
  target.focus();
}

/** Strip the keyboard-selection ring marker from all rows. */
function clearKbdFocus() {
  for (const el of $$("#inbox .kbd-focus")) el.classList.remove("kbd-focus");
}

/** Move the keyboard cursor by `delta` rows (clamped). From outside the list, enter at the
 *  first (j/↓) or last (k/↑) row. */
function moveActiveRow(delta) {
  const rows = inboxRows();
  if (!rows.length) return;
  const current = activeRow();
  const at = current ? rows.indexOf(current) : -1;
  const next =
    at === -1
      ? delta > 0
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, at + delta));
  focusRow(rows[next]);
}

function markActiveRowDone() {
  const row = activeRow();
  // A done row (only in Bookmarks) can't be marked done again — its button is already gone.
  if (row?.dataset.threadId && row.dataset.done !== "true") markDone([row.dataset.threadId]);
}

function copyActiveRowUrl() {
  const url = activeRow()?.querySelector(".n-open")?.dataset.url;
  if (url) copyNotificationUrl(url);
}

/** Toggle the bookmark on the row under the keyboard cursor. */
function bookmarkActiveRow() {
  const btn = activeRow()?.querySelector(".n-bookmark");
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
      moveActiveRow(1);
      return;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      moveActiveRow(-1);
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
    case "r":
      e.preventDefault();
      syncNow();
      return;
  }

  // 1–6 select a smart filter by position (FILTERS insertion order).
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

/** Web URL for a row's repository. Every notification belongs to a repo, so this works even
 *  for subjects with no resolvable link (e.g. Copilot agent sessions). github.com is the
 *  app's only host (see `API_BASE` in github.rs); `full_name` is `owner/repo`. */
function repoUrlForRow(row) {
  const labelled = row.closest(".repo-section")?.getAttribute("aria-labelledby");
  const repoId = labelled ? Number(labelled.slice("repo-h-".length)) : NaN;
  const group = currentGroups().find((g) => g.repo_id === repoId);
  if (!group) return null;
  return `https://github.com/${group.full_name.split("/").map(encodeURIComponent).join("/")}`;
}

/** Right-click a notification row → copy its URL, open its repository, or mark it done. */
function onInboxContextMenu(e) {
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
  // A done row (only in Bookmarks) is already done, so don't offer to mark it done again.
  if (row.dataset.done !== "true") {
    items.push({
      label: "Mark as done",
      danger: true,
      action: () => markDone([threadId]),
    });
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
  // A mouse interaction clears the keyboard-selection ring so it doesn't linger for pointer
  // users (keyboard navigation re-applies it via focusRow).
  $("#inbox").addEventListener("mousedown", clearKbdFocus);
  // Power-user triage shortcuts (j/k/d/e/c/r/1–6) — global so filter/sync keys work from
  // anywhere on the notifications pane, not just when a row has focus.
  document.addEventListener("keydown", onCommandKeydown);
  $("#mark-all-done-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    // Toggle: a second click on the trigger closes the open confirm popover.
    if (isMenuOpen()) {
      closeMenu();
      return;
    }
    const btn = e.currentTarget;
    confirmDone(
      visibleNotifications().filter((n) => !n.is_done).map((n) => n.thread_id),
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
