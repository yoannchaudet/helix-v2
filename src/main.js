import { invoke } from "./js/api.js";
import { $, $$, escapeHtml, toast, announce, copyText } from "./js/dom.js";
import { relTime } from "./js/format.js";
import {
  FILTERS,
  EMPTY_SUBTITLES,
  repoMatches,
  sortReposByRecency,
  filterGroups,
} from "./js/inbox-model.js";
import { loadStorage } from "./js/storage.js";
import { initUpdates } from "./js/updates.js";
import { initSidebarResize } from "./js/sidebar-resize.js";
import { openContextMenu, closeMenu, isMenuOpen, menuContains } from "./js/menu.js";
import { loadAccount, isAuthenticated, configureAccount } from "./js/account.js";
import { session } from "./js/state.js";
import {
  loadSyncStatus,
  syncNow,
  setSyncProgress,
  flashSyncProgress,
  startPolling,
  stopPolling,
  registerSyncEvents,
  configureSync,
} from "./js/sync.js";
import { initSettings, loadSettings, showSettings } from "./js/settings.js";

/* Cross-module sync/poll state lives in `js/state.js`; the sync domain lives in
 * `js/sync.js`. The Settings pane (theme + poll-interval form) lives in `js/settings.js`. */

/* Appearance / theme lives in `js/settings.js` (part of the Settings pane). */

/* ----------------------------- Local storage ----------------------------- */
/* See `js/storage.js` (loadStorage). */

/* -------------------------------- Account -------------------------------- */
/* See `js/account.js` (loadAccount / isAuthenticated / configureAccount). */

/* Notifications status header, sync flow, and poll countdown live in `js/sync.js`
 * (loadSyncStatus / syncNow / setSyncProgress / startPolling / etc.). */

/* ------------------------------ Inbox view -------------------------------- */

const SUBJECT_BADGES = {
  PullRequest: ["PR", "badge--pr"],
  Issue: ["Issue", "badge--issue"],
  Discussion: ["Discussion", "badge--other"],
  Release: ["Release", "badge--other"],
  Commit: ["Commit", "badge--other"],
  AgentSessionThread: ["Copilot", "badge--other"],
  CheckSuite: ["Check", "badge--other"],
  RepositoryVulnerabilityAlert: ["Alert", "badge--alert"],
  RepositoryInvitation: ["Invite", "badge--other"],
};

function subjectBadge(type) {
  const [label, cls] = SUBJECT_BADGES[type] ?? [type, "badge--other"];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

/** Map a resolved subject state to a display pill. `subject_state` is only ever
 *  `open` / `closed` / `merged` (the backend folds a merged PR into `merged`; issue
 *  `state_reason` like completed/not_planned lives in a separate column and isn't shown).
 *  Returns "" for unresolved or non-PR/Issue subjects, so no pill is shown. */
function stateBadge(state) {
  const map = {
    open: ["Open", "state--open"],
    closed: ["Closed", "state--closed"],
    merged: ["Merged", "state--merged"],
  };
  const entry = map[state];
  if (!entry) return "";
  const [label, cls] = entry;
  return `<span class="state ${cls}">${label}</span>`;
}

/** Checkmark glyph for the "mark as done" affordances (row / toolbar / repo header). */
const DONE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 8.5l3 3 6.2-6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function notificationRow(n) {
  const number =
    n.subject_number != null
      ? `<span class="n-number">#${escapeHtml(n.subject_number)}</span> `
      : "";
  const badge = stateBadge(n.subject_state);
  const stateLine = badge ? `<div class="n-state">${badge}</div>` : "";
  const reason = escapeHtml(n.reason.replace(/_/g, " "));
  // Only rows with a resolved web URL are openable (clickable + hover affordance).
  const url = n.subject_html_url || "";
  const cls = `n-row${url ? " n-row--openable" : ""}`;
  const openAttrs = url
    ? ` data-url="${escapeHtml(url)}" role="link" tabindex="0"`
    : "";
  // Contextual accessible name so each row's button isn't an indistinct "Mark as done".
  const doneLabel = escapeHtml(`Mark "${n.subject_title}" as done`);
  return `
    <li class="${cls}" data-thread-id="${escapeHtml(n.thread_id)}">
      <div class="n-open"${openAttrs}>
        <span class="n-badge-slot">${subjectBadge(n.subject_type)}</span>
        <div class="n-main">
          <div class="n-title">${number}${escapeHtml(n.subject_title)}</div>
          ${stateLine}
          <div class="n-meta"><span class="n-reason">${reason}</span> · ${escapeHtml(relTime(n.updated_at))}</div>
        </div>
      </div>
      <button type="button" class="n-done" title="Mark as done" aria-label="${doneLabel}">${DONE_ICON}</button>
    </li>`;
}

/* The sidebar now drives two orthogonal selections: a single notification *type*
 * filter (top group, always exactly one active) and an optional *repository*
 * refinement. Notifications are fetched once into `inboxGroups` and re-rendered
 * locally as either selection changes. */

let inboxGroups = [];
/** Active notification-type filter (always set); one of the FILTERS keys. */
let activeFilter = "all";
/** Optional repository refinement: a repo_id, or null for "all repositories". */
let activeRepo = null;

function repoHeader(group) {
  const privacy = group.private
    ? `<span class="badge badge--lock" title="Private repository">private</span>`
    : "";
  // Read state isn't tracked; show how many notifications are shown for this repo (i.e.
  // matching the active filter — `group.notifications` is already filtered upstream).
  const counts = `<span class="repo-counts">${group.notifications.length}</span>`;
  // A natural sub-filter: clear just this repo's (filtered) notifications.
  const clear = `<button type="button" class="repo-done" data-done-repo="${group.repo_id}" title="Mark this repo's notifications as done" aria-label="Mark ${escapeHtml(group.full_name)} notifications as done">${DONE_ICON}</button>`;
  // The repo name is an <h2> so screen-reader users can navigate the inbox by heading; it
  // also names the group region (see `repoSection`).
  return `
    <div class="repo-header">
      <h2 class="repo-name" id="repo-h-${group.repo_id}">${escapeHtml(group.full_name)}</h2>
      ${privacy}
      ${counts}
      ${clear}
    </div>`;
}

function repoSection(group) {
  const rows = group.notifications.map(notificationRow).join("");
  // `role=group` + `aria-labelledby` ties the list to its repo heading for assistive tech
  // without creating a landmark per repo (which would be noisy with many repos).
  return `<section class="repo-section" role="group" aria-labelledby="repo-h-${group.repo_id}">${repoHeader(
    group,
  )}<ul class="n-list">${rows}</ul></section>`;
}

/** Apply the active filter, then the optional repo refinement, to `inboxGroups`, ordering
 *  the repos most-recent-first. Thin wrapper binding the pure `filterGroups` to the current
 *  inbox state. */
function filteredGroups() {
  return filterGroups(inboxGroups, activeFilter, activeRepo);
}

/** Current toolbar breadcrumb: the filter label, plus the repo when refined. */
function activeTitleHtml() {
  const label = escapeHtml((FILTERS[activeFilter] ?? FILTERS.all).label);
  if (activeRepo != null) {
    const group = inboxGroups.find((g) => g.repo_id === activeRepo);
    if (group) {
      return `${label}<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${escapeHtml(
        group.full_name,
      )}</span>`;
    }
  }
  return label;
}

/** Plain-text accessible name for the breadcrumb (the visual `›` separator is
 *  hidden from assistive tech, so spell out the hierarchy in words here). */
function activeTitleLabel() {
  const label = (FILTERS[activeFilter] ?? FILTERS.all).label;
  if (activeRepo != null) {
    const group = inboxGroups.find((g) => g.repo_id === activeRepo);
    if (group) return `${label}, repository ${group.full_name}`;
  }
  return label;
}

function emptyInbox() {
  if (!isAuthenticated()) {
    return `<div class="inbox-empty">
        <p>Connect your GitHub account to start receiving notifications.</p>
        <button type="button" class="btn js-goto-settings">Open Settings</button>
      </div>`;
  }
  // Authenticated but nothing to show — either the inbox is genuinely empty or the active
  // filter has no matches. Reaching this is a small win, so show the muted helix mark with a
  // filter-specific subtitle (the toolbar already exposes sync status + refresh).
  const sub = EMPTY_SUBTITLES[activeFilter] ?? EMPTY_SUBTITLES.all;
  return `<div class="inbox-empty">
      <img class="inbox-empty-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
      <p class="inbox-empty-title">You're all caught up.</p>
      <p class="inbox-empty-sub">${escapeHtml(sub)}</p>
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

/** Update sidebar filter/repo selection styling + the smart-filter counts. */
function renderSidebar() {
  const all = inboxGroups.flatMap((g) => g.notifications);
  const counts = {
    all: all.length,
    mention: all.filter(FILTERS.mention.match).length,
    team_mention: all.filter(FILTERS.team_mention.match).length,
    review_requested: all.filter(FILTERS.review_requested.match).length,
    assign: all.filter(FILTERS.assign.match).length,
    cleanup: all.filter(FILTERS.cleanup.match).length,
  };
  for (const el of $$(".source-count")) {
    const key = el.dataset.count;
    const value = counts[key] ?? 0;
    el.textContent = value ? String(value) : "";
  }

  // Repositories list — filtered to repos that have notifications matching the
  // active type filter, with counts that reflect that filter.
  const repoList = $("#repo-list");
  let visibleRepos = inboxGroups
    .map((g) => ({ group: g, matches: repoMatches(g, activeFilter) }))
    .filter((x) => x.matches.length);
  // Same most-recent-first ordering as the main list, so the sidebar matches the view.
  visibleRepos = sortReposByRecency(
    visibleRepos,
    (x) => x.matches,
    (x) => x.group.full_name,
  );
  if (!visibleRepos.length) {
    repoList.innerHTML = `<li class="source-empty">No repositories yet.</li>`;
  } else {
    repoList.innerHTML = visibleRepos
      .map(({ group: g, matches }) => {
        // Total notifications matching the active filter in this repo (read state untracked).
        const count = matches.length
          ? `<span class="source-count">${matches.length}</span>`
          : "";
        const lock = g.private ? " 🔒" : "";
        return `<li>
          <button type="button" class="source repo-source" data-repo="${g.repo_id}">
            <span class="source-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            </span>
            <span class="source-label" title="${escapeHtml(g.full_name)}">${escapeHtml(
              g.full_name,
            )}${lock}</span>
            ${count}
          </button>
        </li>`;
      })
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
function selectFilter(filterId) {
  activeFilter = filterId;
  if (activeRepo != null) {
    const group = inboxGroups.find((g) => g.repo_id === activeRepo);
    if (!group || !repoMatches(group, activeFilter).length) activeRepo = null;
  }
  showSettings(false);
  renderSidebar();
  renderInbox();
  announceView();
}

/** Toggle the repository refinement: select it, or clear it if already active. */
function selectRepo(repoId) {
  activeRepo = activeRepo === repoId ? null : repoId;
  showSettings(false);
  renderSidebar();
  renderInbox();
  announceView();
}

/** Announce the current view (its spelled-out label + how many notifications it shows) to
 *  assistive tech, since the visual heading update isn't announced on its own. */
function announceView() {
  const count = visibleNotifications().length;
  const noun = count === 1 ? "notification" : "notifications";
  announce(`${activeTitleLabel()}, ${count} ${noun}.`);
}

async function loadInbox() {
  try {
    inboxGroups = await invoke("list_inbox");
    // Drop a repo refinement whose repository is no longer present after a sync.
    if (activeRepo != null && !inboxGroups.some((g) => g.repo_id === activeRepo)) {
      activeRepo = null;
    }
    renderSidebar();
    renderInbox();
  } catch (err) {
    $("#inbox").innerHTML = `<pre class="error-detail">${escapeHtml(err)}</pre>`;
  }
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
  const focusTarget = focusTargetAfterRemoval(ids);
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
  if (activeRepo != null && !inboxGroups.some((g) => g.repo_id === activeRepo)) {
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

/* ------------------------------ Context menu ------------------------------ */
/* See `js/menu.js` (openContextMenu / closeMenu / isMenuOpen / menuContains). */

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
  if (e.target.closest?.(".n-done, .repo-done")) return;
  const open = e.target.closest?.(".n-open");
  if (!open?.dataset.url) return;
  e.preventDefault();
  openNotification(open.dataset.url);
}

/** Confirm + mark all of one repo's (filtered) notifications done, from its header icon. */
function confirmRepoDone(btn) {
  const repoId = Number(btn.dataset.doneRepo);
  const group = filteredGroups().find((g) => g.repo_id === repoId);
  const ids = group ? group.notifications.map((n) => n.thread_id) : [];
  confirmDone(ids, btn);
}

/** Right-click a notification row → copy its URL (if resolved) and/or mark done. */
function onInboxContextMenu(e) {
  const row = inboxRowFromEvent(e);
  if (!row) return;
  e.preventDefault();
  const threadId = row.dataset.threadId;
  if (!threadId) return;
  const url = row.querySelector(".n-open")?.dataset.url;
  // A keyboard-triggered context menu (Menu key / Shift+F10) reports 0,0; anchor the
  // menu to the row instead so it doesn't appear detached in the corner.
  let { clientX: x, clientY: y } = e;
  if (x === 0 && y === 0) {
    const r = row.getBoundingClientRect();
    x = r.left + 12;
    y = r.bottom - 8;
  }
  openContextMenu(x, y, [
    {
      label: "Copy URL",
      disabled: !url,
      action: () => copyNotificationUrl(url),
    },
    {
      label: "Mark as done",
      danger: true,
      action: () => markDone([threadId]),
    },
  ]);
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


/* -------------------------------- Settings ------------------------------- */
/* The Settings pane (theme picker + poll-interval form) and the notifications/Settings
 * pane toggle live in `js/settings.js` (initSettings / loadSettings / showSettings). */

/* -------------------------------- Updates ------------------------------- */
/* See `js/updates.js` (initUpdates + the prompt banner / Settings → Updates flow). */

/* ----------------------------- Sidebar resize ---------------------------- */
/* See `js/sidebar-resize.js` (initSidebarResize). */

/* --------------------------------- Init ---------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  // Tag the platform so macOS-only chrome (e.g. the traffic-light toolbar inset) is scoped
  // to macOS and doesn't apply on Windows/Linux (the app bundles for all targets).
  if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.dataset.platform = "macos";
  }
  // Settings pane: theme picker, poll-interval form, pane open/close, and ⌘, all wired here.
  initSettings();

  for (const btn of $$(".js-sync-btn")) btn.addEventListener("click", syncNow);

  initSidebarResize();

  // Sidebar smart filters.
  for (const btn of $$(".source[data-filter]")) {
    btn.addEventListener("click", () => selectFilter(btn.dataset.filter));
  }

  // Notification actions: left-click an (openable) row to open it in the browser,
  // right-click for the row menu, ••• for the visible set. Enter opens a focused row.
  $("#inbox").addEventListener("click", onInboxClick);
  $("#inbox").addEventListener("keydown", onInboxKeydown);
  $("#inbox").addEventListener("contextmenu", onInboxContextMenu);
  $("#mark-all-done-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    // Toggle: a second click on the trigger closes the open confirm popover.
    if (isMenuOpen()) {
      closeMenu();
      return;
    }
    const btn = e.currentTarget;
    confirmDone(visibleNotifications().map((n) => n.thread_id), btn);
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

  registerSyncEvents();
  // Sync reloads the inbox after a sync (and after background subject resolution) via this
  // hook, so the inbox view can stay in main.js without sync importing it (avoids a cycle).
  configureSync({ onInboxStale: loadInbox });
  // Wire account auth transitions to the poll/sync lifecycle. account.js doesn't import the
  // sync machinery directly (avoids a circular dependency); it fires these hooks instead.
  configureAccount({
    onAuthenticated: (justSignedIn) => {
      // Signed in → begin the automatic poll loop (idempotent; restarts the countdown).
      startPolling();
      if (justSignedIn) {
        // Fresh sign-in: refresh the cached login display + sync status with the new creds.
        loadSettings();
        loadSyncStatus();
      }
    },
    onSignedOut: () => {
      // A new session must re-prove a successful sync before the status pill goes green
      // again, so a stale persisted "success" doesn't show as green after re-signing in.
      session.syncedThisSession = false;
      // Signed out → stop polling so we never hit the API without a token.
      stopPolling();
    },
  });
  loadStorage();
  loadSyncStatus();
  loadSettings();
  initUpdates();
  // Load the account first so the inbox knows whether to show its signed-out hint.
  loadAccount().finally(loadInbox);

  // The window starts hidden (see tauri.conf.json) to avoid a flash on launch;
  // reveal it from Rust now that the DOM is built and styled. We do not wait on
  // requestAnimationFrame: a hidden macOS WKWebView never paints, so its rAF
  // callbacks would never fire and the window would stay hidden forever. The Rust
  // safety-net (see lib.rs) reveals the window if this call ever fails.
  invoke("show_main_window").catch(() => {});
});

