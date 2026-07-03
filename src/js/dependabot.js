import { invoke, listen } from "./api.js";
import { $, $$, html, rawHtml, toast, announce } from "./dom.js";
import { STATES } from "./constants.js";
import { relTime } from "./format.js";
import { filterDependabotGroups, totalPrs } from "./dependabot-model.js";
import { repoSection } from "./dependabot-view.js";
import { sourceButton } from "./ui.js";
import { isAuthenticated } from "./account.js";
import { isMenuOpen } from "./menu.js";
import { isShortcutsOpen } from "./shortcuts.js";

/* The Dependabot module: a read-only list of open Dependabot PRs grouped by repository, its
 * repo-only sidebar refinement, keyboard navigation, and its own sync flow. Pure row/section
 * HTML lives in `dependabot-view.js`; the pure repo pipeline in `dependabot-model.js`; this
 * module owns all state and DOM wiring. Deliberately trimmed vs. the inbox: no smart filters,
 * no type pills, no bookmarks, no mark-done.
 *
 * Data is offline-first: `loadDependabot` reads the cached PRs from SQLite (`list_dependabot`)
 * and GitHub is only contacted on a sync (`sync_dependabot`). Auto-sync on module open is
 * staleness-gated (see `onDependabotOpened`) so repeated opens don't hammer the Search API. */

/** By-repo PR groups from the backend (`{ full_name, total, prs }[]`). */
let depGroups = [];
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

/** Auto-sync-on-open only fires if we've never synced this session or it's been at least
 *  this long since the last sync — keeping the Search API (a small ~30 req/min bucket)
 *  from being hit on every module open. */
const AUTO_SYNC_STALE_MS = 5 * 60 * 1000;

const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

/* -------------------------------- Rendering ------------------------------- */

/** The groups to show: the active repo refinement (if any), recency-sorted. */
function visibleGroups() {
  return filterDependabotGroups(depGroups, activeRepo);
}

function emptyDependabot() {
  if (!isAuthenticated()) {
    return html`<div class="inbox-empty">
      <p>Connect your GitHub account to see your Dependabot pull requests.</p>
    </div>`;
  }
  return html`<div class="inbox-empty">
    <img class="inbox-empty-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
    <p class="inbox-empty-title">No open Dependabot pull requests.</p>
    <p class="inbox-empty-sub">
      Open Dependabot PRs in repositories you <strong>admin</strong> (across your selected
      accounts) show up here. Use <span class="inbox-empty-hint">Choose accounts</span> in the
      toolbar to pick your user and orgs.
    </p>
  </div>`;
}

/** Snapshot the focused PR row id so a re-render can restore focus (the list re-renders
 *  wholesale on refine/sync, which would otherwise drop focus to <body>). */
function captureFocus() {
  const active = document.activeElement;
  const list = $("#dependabot");
  if (!active || !list || !list.contains(active)) return null;
  const row = active.closest(".n-row");
  return row?.dataset.prId ?? null;
}

/** Restore focus to a PR row by id after a re-render. Returns true if it landed. */
function applyFocus(prId, { preventScroll = false } = {}) {
  if (prId == null) return false;
  const safe = String(prId).replace(/["\\]/g, "\\$&");
  const open = $("#dependabot")?.querySelector(`.n-row[data-pr-id="${safe}"] .n-open[tabindex]`);
  if (!open) return false;
  open.focus({ preventScroll });
  return true;
}

/** Render the central PR list for the active repo refinement. */
function renderList() {
  const list = $("#dependabot");
  if (!list) return;
  const preserved = captureFocus();
  const groups = visibleGroups();
  if (!groups.length) {
    list.innerHTML = emptyDependabot();
    return;
  }
  list.innerHTML = groups.map(repoSection).join("");
  if (preserved != null && !applyFocus(preserved, { preventScroll: true })) {
    list.querySelector(".n-open[tabindex]")?.focus({ preventScroll: true });
  }
}

/** Render the repo-only sidebar for the Dependabot module (counts + active highlight). */
function renderSidebar() {
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
        active: g.full_name === activeRepo,
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
  if (activeRepo != null) {
    title.innerHTML = html`Dependabot<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${activeRepo}</span>`;
    title.setAttribute("aria-label", `Dependabot, repository ${activeRepo}`);
  } else {
    title.textContent = "Dependabot";
    title.removeAttribute("aria-label");
  }
}

/** Announce the current view to assistive tech (the visual heading change isn't announced). */
function announceView() {
  const count = totalPrs(visibleGroups());
  const noun = count === 1 ? "pull request" : "pull requests";
  const where = activeRepo != null ? `Dependabot, repository ${activeRepo}` : "Dependabot";
  announce(`${where}, ${count} ${noun}.`);
}

/** Toggle the repository refinement: select it, or clear it if already active. */
function selectRepo(fullName, kbd = false) {
  activeRepo = activeRepo === fullName ? null : fullName;
  renderTitle();
  renderSidebar();
  renderList();
  if (kbd) $("#dependabot").querySelector(".n-row")?.querySelector(".n-open[tabindex]")?.focus();
  announceView();
}

/* --------------------------------- Loading -------------------------------- */

/** Load the cached Dependabot PRs from SQLite and render (offline-first; no network). */
export async function loadDependabot() {
  try {
    depGroups = await invoke("list_dependabot");
    // Drop a repo refinement whose repository is no longer present.
    if (activeRepo != null && !depGroups.some((g) => g.full_name === activeRepo)) {
      activeRepo = null;
    }
    renderTitle();
    renderSidebar();
    renderList();
  } catch (err) {
    $("#dependabot").innerHTML = html`<pre class="error-detail">${err}</pre>`;
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
  const open = el?.closest(".n-open");
  if (open?.dataset.url) openPr(open.dataset.url);
}

/** Enter on a focused PR row → open it (links activate on Enter, not Space). */
function onListKeydown(e) {
  if (e.key !== "Enter") return;
  const open = e.target.closest?.(".n-open");
  if (!open?.dataset.url) return;
  e.preventDefault();
  openPr(open.dataset.url);
}

/* ------------------------- Keyboard command model ------------------------- */

/** All PR rows currently in the DOM, in visual order. */
function rows() {
  return [...$("#dependabot").querySelectorAll(".n-row")];
}

/** The row the keyboard cursor is on, or null. */
function activeRow() {
  const el = document.activeElement;
  return el instanceof HTMLElement ? el.closest("#dependabot .n-row") : null;
}

/** Move the keyboard cursor by `delta` rows (clamped); enter at an end from outside. */
function moveActiveRow(delta) {
  const all = rows();
  if (!all.length) return;
  const current = activeRow();
  const at = current ? all.indexOf(current) : -1;
  const next =
    at === -1
      ? delta > 0
        ? 0
        : all.length - 1
      : Math.min(all.length - 1, Math.max(0, at + delta));
  all[next].querySelector(".n-open[tabindex]")?.focus();
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
      moveActiveRow(1);
      return;
    case "k":
    case "ArrowUp":
      e.preventDefault();
      moveActiveRow(-1);
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

/** Run a Dependabot sync: search GitHub, store, and reload the list. Manages its own status
 *  chrome (independent of the Notifications sync). If a sync is already in flight (e.g. the
 *  account scope just changed), queue exactly one follow-up so the new scope isn't lost. */
export async function syncDependabot() {
  if (!isAuthenticated()) {
    setDepProgress("Connect a GitHub token to sync Dependabot.", "error");
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
  try {
    const result = await invoke("sync_dependabot");
    syncing = false;
    lastSyncAt = Date.now();
    const removed = result.removed ?? 0;
    const msg = `Found ${result.count} PR${result.count === 1 ? "" : "s"}`;
    setDepProgress(removed > 0 ? `${msg}, removed ${removed}.` : `${msg}.`, "success");
    setDepStatus("success", "Synced just now");
    await loadDependabot();
  } catch (err) {
    syncing = false;
    setDepStatus("error", "Error");
    // GitHub's raw rate-limit 403 body is noisy; show a short, actionable message instead.
    const raw = String(err);
    const friendly = /rate limit/i.test(raw)
      ? "GitHub is rate-limiting requests right now. Wait a few minutes, then sync again."
      : raw;
    setDepProgress(friendly, "error");
  } finally {
    syncing = false;
    setDepBusy(false);
    // A scope change (or another trigger) arrived mid-sync — run it now with the latest scope.
    if (pendingSync) {
      pendingSync = false;
      syncDependabot();
    }
  }
}

/* ------------------------------ Accounts picker --------------------------- */

/* A small popover (anchored under the toolbar "Choose accounts" button) letting the user
 * scope the Dependabot search to their own account + selected orgs. Toggling updates a local
 * selection; closing the popover persists it (`set_dependabot_owners`) and re-syncs if it
 * changed. Self-contained rather than reusing the action-oriented context menu, since this is
 * a multi-select that must stay open across toggles. */

/** The open picker element, or null. */
let pickerEl = null;
/** The selection being edited (a Set of logins) while the picker is open. */
let pickerSelection = null;
/** Order-insensitive signature of the selection when the picker opened, so we only persist +
 *  re-sync when the *set* actually changed (not merely toggled and restored). */
let pickerBaseline = "";
/** Guards against overlapping opens while `list_dependabot_owners` is in flight. */
let pickerOpening = false;

/** Order-insensitive, case-insensitive signature of an owner list. */
function ownersKey(owners) {
  return [...owners]
    .map((o) => o.toLowerCase())
    .sort()
    .join(",");
}

function pickerOpen() {
  return pickerEl != null;
}

/** Persist + re-sync only if the selection changed, then tear down the popover. */
async function closeAccountsPicker() {
  if (!pickerEl) return;
  const el = pickerEl;
  const selection = pickerSelection;
  const baseline = pickerBaseline;
  pickerEl = null;
  pickerSelection = null;
  el.remove();
  document.removeEventListener("mousedown", onPickerOutside, true);
  document.removeEventListener("keydown", onPickerKeydown, true);
  const btn = $("#dependabot-accounts-btn");
  btn?.setAttribute("aria-expanded", "false");
  btn?.focus();

  const owners = [...selection];
  if (ownersKey(owners) === baseline) return; // unchanged → nothing to do
  try {
    await invoke("set_dependabot_owners", { owners });
    await syncDependabot();
  } catch (err) {
    setDepProgress(String(err), "error");
  }
}

function onPickerOutside(e) {
  const t = e.target;
  if (pickerEl && !pickerEl.contains(t) && !t.closest?.("#dependabot-accounts-btn")) {
    closeAccountsPicker();
  }
}

function onPickerKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeAccountsPicker();
  }
}

/** Open the accounts picker: fetch the user + their orgs, render checkboxes reflecting the
 *  current selection, and wire toggles. */
async function openAccountsPicker() {
  if (pickerOpen()) {
    closeAccountsPicker();
    return;
  }
  if (pickerOpening) return; // a fetch is already in flight
  const btn = $("#dependabot-accounts-btn");
  if (!btn) return;
  pickerOpening = true;
  let options;
  try {
    options = await invoke("list_dependabot_owners");
  } catch (err) {
    setDepProgress(String(err), "error");
    return;
  } finally {
    pickerOpening = false;
  }
  // Bail if dismissed/reopened while awaiting, or the module was left.
  if (pickerOpen() || $("#view-dependabot")?.hidden) return;

  pickerSelection = new Set(options.filter((o) => o.selected).map((o) => o.login));
  pickerBaseline = ownersKey(pickerSelection);

  const rows = options
    .map((o) => {
      const tag = o.is_org ? "org" : "you";
      return html`<label class="accounts-row">
        <input type="checkbox" class="accounts-check" data-login="${o.login}"${o.selected ? " checked" : ""} />
        <span class="accounts-login">${o.login}</span>
        <span class="accounts-tag">${tag}</span>
      </label>`;
    })
    .join("");
  const panel = document.createElement("div");
  panel.className = "accounts-popover";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Choose accounts to track");
  panel.innerHTML = html`<p class="accounts-title">Track Dependabot PRs from</p>
    <div class="accounts-list">${rawHtml(rows)}</div>
    <p class="accounts-note">Changes apply on close.</p>`;
  document.body.appendChild(panel);

  // Anchor under the button, right-aligned so it doesn't overflow the window edge.
  const r = btn.getBoundingClientRect();
  panel.style.top = `${Math.round(r.bottom + 4)}px`;
  const width = panel.offsetWidth || 240;
  panel.style.left = `${Math.round(Math.max(8, r.right - width))}px`;

  for (const cb of panel.querySelectorAll(".accounts-check")) {
    cb.addEventListener("change", () => {
      if (cb.checked) pickerSelection.add(cb.dataset.login);
      else pickerSelection.delete(cb.dataset.login);
    });
  }

  pickerEl = panel;
  btn.setAttribute("aria-expanded", "true");
  document.addEventListener("mousedown", onPickerOutside, true);
  document.addEventListener("keydown", onPickerKeydown, true);
  panel.querySelector(".accounts-check")?.focus();
}

/** Called by main.js when the Dependabot module becomes active: render cached PRs, then
 *  auto-sync if stale (never synced this session, or older than the staleness window). */
export function onDependabotOpened() {
  loadDependabot();
  if (!isAuthenticated()) return;
  if (!lastSyncAt || Date.now() - lastSyncAt > AUTO_SYNC_STALE_MS) {
    syncDependabot();
  }
}

/* ---------------------------------- Init --------------------------------- */

/** Wire the Dependabot module's DOM listeners + sync events. Call once on DOMContentLoaded. */
export function initDependabot() {
  const list = $("#dependabot");
  if (list) {
    list.addEventListener("click", onListClick);
    list.addEventListener("keydown", onListKeydown);
  }
  document.addEventListener("keydown", onCommandKeydown);
  $("#dependabot-sync-btn")?.addEventListener("click", syncDependabot);
  $("#dependabot-accounts-btn")?.addEventListener("click", openAccountsPicker);
  // Close the picker (persisting any change) if the window loses focus, mirroring the
  // context menu's dismissal.
  window.addEventListener("blur", () => {
    if (pickerOpen()) closeAccountsPicker();
  });
  renderIdleStatus();

  // Live progress during a sync (repos scanned / Dependabot PRs found).
  listen("dependabot:progress", (event) => {
    if (!syncing) return;
    const { found } = event.payload ?? {};
    setDepProgress(`Scanning repositories… (${found ?? 0} found)`);
  });
  // Merge-readiness pills resolve in the background after a sync; reload once they land.
  listen("dependabot:resolved", () => {
    loadDependabot();
  });
}
