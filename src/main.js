const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** True once the user is authenticated; drives the signed-out empty state. */
let authenticated = false;

const STATES = ["pending", "success", "error"];

/** True while a sync is in flight; gates stale sync:progress events. */
let syncing = false;

/** Timer that clears the transient post-sync "Stored N" progress message. */
let syncProgressTimer;

/* ----------------------------- Poll state -------------------------------- */

/** 1-second tick driving the automatic poll + the refresh-button clock sweep. */
let pollTimer = null;
/** Configured polling cadence (seconds); kept in sync with the saved setting. */
let pollIntervalSeconds = 60;
/** Seconds elapsed since the last sync; reset to 0 after every sync. */
let pollElapsed = 0;

/** Briefly show a transient confirmation element (e.g. "Saved", "Copied"), then fade it
 * out. Reuses the `.srow-flash` styling. Pass `kind = "error"` for a red message. */
function flash(el, text, kind) {
  if (!el) return;
  if (text != null) el.textContent = text;
  el.classList.toggle("srow-flash--error", kind === "error");
  el.classList.add("srow-flash--show");
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => {
    el.classList.remove("srow-flash--show");
  }, 1800);
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/* ----------------------------- Local storage ----------------------------- */

async function loadStorage() {
  try {
    const status = await invoke("db_status");
    const tables = status.tables.length
      ? status.tables.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("")
      : "<li><em>no tables</em></li>";
    $("#storage-body").innerHTML = `
      <div class="srow">
        <span class="srow-label">Database</span>
        <span class="srow-value">
          <span class="dbpath" id="db-path" role="button" tabindex="0"
          title="Copy database path" aria-label="Copy database path">${escapeHtml(status.path)}</span>
          <span class="srow-flash" id="db-copy-flash" role="status" aria-live="polite">Copied</span>
          <button type="button" class="icon-btn" id="reveal-db" title="Reveal in Finder" aria-label="Reveal in Finder">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.75 5.25V4c0-.7.55-1.25 1.25-1.25h2.8c.33 0 .65.13.88.37l.99.96H13c.7 0 1.25.55 1.25 1.25v6c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
        </span>
      </div>
      <div class="srow">
        <span class="srow-label">Schema version</span>
        <span class="srow-value">v${escapeHtml(status.schema_version)}</span>
      </div>
      <div class="srow">
        <span class="srow-label">Tables</span>
        <span class="srow-value"><ul class="tables">${tables}</ul></span>
      </div>`;

    const path = status.path;
    $("#reveal-db").addEventListener("click", () => {
      invoke("reveal_in_finder", { path }).catch((err) => {
        console.error(err);
        flash($("#db-copy-flash"), "Reveal failed", "error");
      });
    });
    const copyPath = async () => {
      try {
        await navigator.clipboard.writeText(path);
        flash($("#db-copy-flash"), "Copied");
      } catch (err) {
        console.error(err);
        flash($("#db-copy-flash"), "Copy failed", "error");
      }
    };
    const dbPathEl = $("#db-path");
    dbPathEl.addEventListener("click", copyPath);
    // Keyboard support for the button-role path (Enter / Space activate copy).
    dbPathEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        copyPath();
      }
    });
  } catch (err) {
    $("#storage-body").innerHTML = `
      <div class="srow">
        <p class="error-text">Could not open the local database.</p>
      </div>
      <div class="srow">
        <pre class="error-detail">${escapeHtml(err)}</pre>
      </div>`;
  }
}

/* -------------------------------- Account -------------------------------- */

function renderSignedIn(login, name) {
  authenticated = true;
  // Signed in → begin the automatic poll loop (idempotent; restarts the countdown).
  startPolling();
  // Treat a missing or placeholder login as "no avatar": fetching
  // github.com/(unknown).png would 404 and the fallback letter would be "(".
  const hasLogin = Boolean(login) && login !== "(unknown)";
  const safeLogin = escapeHtml(login);
  const hasName = Boolean(name);
  const primary = hasName ? escapeHtml(name) : hasLogin ? `@${safeLogin}` : "Signed in";
  const secondary =
    hasName && hasLogin ? `<span class="account-login">@${safeLogin}</span>` : "";
  const avatar = hasLogin
    ? `<img class="avatar" id="account-avatar" alt=""
        src="https://github.com/${encodeURIComponent(login)}.png?size=96" />`
    : `<span class="avatar avatar--fallback" aria-hidden="true">?</span>`;
  $("#account-body").innerHTML = `
    <div class="srow srow--account">
      ${avatar}
      <div class="account-meta">
        <span class="account-name">${primary}</span>
        ${secondary}
      </div>
      <button type="button" class="btn" id="sign-out">Sign out</button>
    </div>`;

  // Graceful fallback to an initial-letter chip if the avatar image can't load.
  const img = $("#account-avatar");
  if (img) {
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "avatar avatar--fallback";
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = login.charAt(0);
      img.replaceWith(fallback);
    });
  }
  $("#sign-out").addEventListener("click", signOut);
}

function renderSignedOut(message) {
  authenticated = false;
  // Signed out → stop polling so we never hit the API without a token.
  stopPolling();
  $("#account-body").innerHTML = `
    <form id="signin-form" class="form">
      <div class="field">
        <label for="pat">GitHub Personal Access Token</label>
        <input id="pat" name="pat" type="password" autocomplete="off"
          placeholder="ghp_… or github_pat_…" />
        <p class="hint">
          Needs the <code>notifications</code> scope (add <code>repo</code> for private
          repositories). Stored in your macOS Keychain.
        </p>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn--primary" id="signin-btn">Connect</button>
        <span class="form-msg ${message ? "form-msg--error" : ""}" id="signin-msg">
          ${message ? escapeHtml(message) : ""}
        </span>
      </div>
    </form>`;
  $("#signin-form").addEventListener("submit", signIn);
}

async function signIn(event) {
  event.preventDefault();
  const token = $("#pat").value;
  const btn = $("#signin-btn");
  const msg = $("#signin-msg");

  btn.disabled = true;
  msg.className = "form-msg";
  msg.textContent = "Verifying with GitHub…";

  try {
    const user = await invoke("sign_in", { token });
    renderSignedIn(user.login, user.name);
    await loadSettings(); // refresh cached login display
    await loadSyncStatus();
  } catch (err) {
    renderSignedOut(String(err));
  }
}

async function signOut() {
  try {
    await invoke("sign_out");
  } catch (err) {
    // Even on error, fall back to the signed-out view.
    console.error(err);
  }
  renderSignedOut();
}

async function loadAccount() {
  try {
    const status = await invoke("auth_status");
    if (status.authenticated && status.login) {
      renderSignedIn(status.login);
    } else if (status.authenticated) {
      renderSignedIn("(unknown)");
    } else {
      renderSignedOut();
    }
  } catch (err) {
    $("#account-body").innerHTML =
      `<div class="srow"><pre class="error-detail">${escapeHtml(err)}</pre></div>`;
  }
}

/* ------------------------------ Notifications ----------------------------- */

function fmtTimestamp(value) {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function renderSyncStats(status) {
  const rate =
    status.rate_remaining === null || status.rate_remaining === undefined
      ? "—"
      : status.rate_remaining;
  const lastEl = $("#last-synced");
  if (lastEl) lastEl.textContent = fmtTimestamp(status.last_sync_at);
  const rateEl = $("#rate-remaining");
  if (rateEl) rateEl.textContent = rate;

  if (status.last_status === "error" && status.last_error) {
    setSyncStatus("error", "Error");
    setSyncProgress(status.last_error, "error");
  } else if (status.last_status === "success") {
    setSyncStatus("success", "Synced");
  } else {
    setSyncStatus("pending", "Never synced");
  }
}

/* The sync controls live in two places (the Notifications header and the Settings
 * summary). These helpers update every instance at once so both stay in lockstep. */

function setSyncStatus(state, text) {
  for (const dot of $$(".js-sync-dot")) {
    for (const s of STATES) dot.classList.remove(`status-dot--${s}`);
    dot.classList.add(`status-dot--${state}`);
  }
  for (const label of $$(".js-sync-label")) {
    for (const s of STATES) label.classList.remove(`status-label--${s}`);
    label.classList.add(`status-label--${state}`);
    label.textContent = text;
  }
}

function setSyncProgress(text, kind = "") {
  for (const el of $$(".js-sync-progress")) {
    el.className = `form-msg js-sync-progress${kind ? ` form-msg--${kind}` : ""}`;
    el.textContent = text;
  }
}

function setSyncBusy(busy) {
  for (const btn of $$(".js-sync-btn")) btn.disabled = busy;
  // The toolbar button turns the accent color while a sync is in flight (due state).
  $("#sync-btn")?.classList.toggle("is-due", busy);
}

async function loadSyncStatus() {
  setSyncStatus("pending", "Loading…");
  try {
    const status = await invoke("sync_status");
    renderSyncStats(status);
  } catch (err) {
    setSyncStatus("error", "Error");
    setSyncProgress(String(err), "error");
  }
}

async function syncNow() {
  setSyncBusy(true);
  syncing = true;
  clearTimeout(syncProgressTimer);
  setSyncStatus("pending", "Syncing…");
  setSyncProgress("Starting…");

  try {
    const result = await invoke("sync_now");
    // Stop accepting progress updates before writing the final message, so a
    // late-delivered sync:progress event can't overwrite it.
    syncing = false;
    const removed = result.removed ?? 0;
    const storedMsg = `Stored ${result.count} notification${result.count === 1 ? "" : "s"}`;
    setSyncProgress(
      removed > 0
        ? `${storedMsg}, removed ${removed}.`
        : `${storedMsg}.`,
      "success",
    );
    // Transient: the durable record is the "Last synced" row, so clear the inline
    // "Stored N" message shortly after it appears.
    clearTimeout(syncProgressTimer);
    syncProgressTimer = setTimeout(() => setSyncProgress(""), 2600);
    await loadSyncStatus();
    await loadInbox();
  } catch (err) {
    syncing = false;
    setSyncStatus("error", "Error");
    setSyncProgress(String(err), "error");
  } finally {
    syncing = false;
    setSyncBusy(false);
    // Restart the countdown so the next automatic poll is measured from the most
    // recent sync, whether it was triggered manually or by the poll loop.
    resetPollCountdown();
  }
}

/* ------------------------------ Poll countdown ---------------------------- */

/** Write the current fraction (0–1) into the refresh button's clock sweep. */
function setPollProgress(frac) {
  $("#sync-btn")?.style.setProperty("--poll-progress", String(frac));
}

function resetPollCountdown() {
  pollElapsed = 0;
  setPollProgress(0);
}

/** One-second tick: advance the sweep and fire an automatic sync when due. */
function pollTick() {
  // Hold the countdown while signed out or while a sync is already running.
  if (!authenticated || syncing) return;
  pollElapsed += 1;
  const interval = Math.max(pollIntervalSeconds, 10);
  setPollProgress(Math.min(pollElapsed / interval, 1));
  if (pollElapsed >= interval) syncNow();
}

/** Begin (or restart) the automatic poll loop. Safe to call repeatedly. */
function startPolling() {
  stopPolling();
  resetPollCountdown();
  pollTimer = setInterval(pollTick, 1000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  resetPollCountdown();
}

/** Live progress from the backend during a sync. */
function registerSyncEvents() {
  listen("sync:progress", (event) => {
    // Ignore stale events delivered after the sync has settled.
    if (!syncing) return;
    const { page, fetched } = event.payload ?? {};
    setSyncProgress(`Fetching page ${page}… (${fetched} so far)`);
  });
  // Subject states (Open/Closed/Merged pills) resolve in the background after a sync;
  // reload the inbox once they land so the pills appear without another sync, and refresh
  // the sync stats so the rate-limit count reflects the extra resolution calls.
  listen("subjects:resolved", () => {
    loadInbox();
    loadSyncStatus();
  });
}

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

/** Map a resolved subject state to a display pill. Simple labels — Open / Closed / Merged
 *  (issue `completed`/`not_planned` both read as Closed). Returns "" for unresolved or
 *  non-PR/Issue subjects, so no pill is shown. */
function stateBadge(state) {
  const map = {
    open: ["Open", "state--open"],
    closed: ["Closed", "state--closed"],
    completed: ["Closed", "state--closed"],
    not_planned: ["Closed", "state--closed"],
    merged: ["Merged", "state--merged"],
  };
  const entry = map[state];
  if (!entry) return "";
  const [label, cls] = entry;
  return `<span class="state ${cls}">${label}</span>`;
}

function relTime(value) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return value;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
}

function notificationRow(n) {
  const number =
    n.subject_number != null
      ? `<span class="n-number">#${escapeHtml(n.subject_number)}</span> `
      : "";
  const badge = stateBadge(n.subject_state);
  const stateLine = badge ? `<div class="n-state">${badge}</div>` : "";
  const reason = escapeHtml(n.reason.replace(/_/g, " "));
  return `
    <li class="n-row ${n.unread ? "n-row--unread" : ""}">
      <span class="n-unread-dot"${n.unread ? ' role="img" title="Unread" aria-label="Unread"' : ' aria-hidden="true"'}></span>
      <span class="n-badge-slot">${subjectBadge(n.subject_type)}</span>
      <div class="n-main">
        <div class="n-title">${number}${escapeHtml(n.subject_title)}</div>
        ${stateLine}
        <div class="n-meta">${reason} · ${escapeHtml(relTime(n.updated_at))}</div>
      </div>
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

/** Smart filters: predicate over a notification + the human label for the toolbar. */
const FILTERS = {
  all: { label: "All", match: () => true },
  mention: { label: "Mentions", match: (n) => n.reason === "mention" },
  team_mention: {
    label: "Team mentions",
    match: (n) => n.reason === "team_mention",
  },
  review_requested: {
    label: "Review requests",
    match: (n) => n.reason === "review_requested",
  },
  assign: { label: "Assigned", match: (n) => n.reason === "assign" },
};

function repoHeader(group) {
  const privacy = group.private
    ? `<span class="badge badge--lock" title="Private repository">private</span>`
    : "";
  const unread = group.notifications.filter((n) => n.unread).length;
  const counts = unread
    ? `<span class="repo-counts"><strong>${unread}</strong> unread</span>`
    : `<span class="repo-counts">${group.notifications.length}</span>`;
  return `
    <div class="repo-header">
      <span class="repo-name">${escapeHtml(group.full_name)}</span>
      ${privacy}
      ${counts}
    </div>`;
}

function repoSection(group) {
  const rows = group.notifications.map(notificationRow).join("");
  return `${repoHeader(group)}<ul class="n-list">${rows}</ul>`;
}

/** Notifications in `group` matching the given type filter. */
function repoMatches(group, filterId) {
  const match = (FILTERS[filterId] ?? FILTERS.all).match;
  return group.notifications.filter(match);
}

/** Apply the active filter, then the optional repo refinement, to `inboxGroups`. */
function filteredGroups() {
  let groups = inboxGroups
    .map((g) => ({ ...g, notifications: repoMatches(g, activeFilter) }))
    .filter((g) => g.notifications.length);
  if (activeRepo != null) {
    groups = groups.filter((g) => g.repo_id === activeRepo);
  }
  return groups;
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
  if (!authenticated) {
    return `<div class="inbox-empty">
        <p>Connect your GitHub account to start receiving notifications.</p>
        <button type="button" class="btn js-goto-settings">Open Settings</button>
      </div>`;
  }
  return `<p class="inbox-empty">Nothing here. Click the refresh button to sync.</p>`;
}

/** Render the main list for the active filter (and optional repo refinement). */
function renderInbox() {
  const inbox = $("#inbox");
  const title = $("#view-title");
  title.innerHTML = activeTitleHtml();
  // The visual `›` is aria-hidden, so give the heading a spelled-out accessible name.
  title.setAttribute("aria-label", activeTitleLabel());
  const groups = filteredGroups();
  if (!groups.length) {
    inbox.innerHTML = emptyInbox();
    const goto = inbox.querySelector(".js-goto-settings");
    if (goto) goto.addEventListener("click", () => showSettings(true));
    return;
  }
  inbox.innerHTML = groups.map(repoSection).join("");
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
  };
  for (const el of $$(".source-count")) {
    const key = el.dataset.count;
    const value = counts[key] ?? 0;
    el.textContent = value ? String(value) : "";
  }

  // Repositories list — filtered to repos that have notifications matching the
  // active type filter, with counts that reflect that filter.
  const repoList = $("#repo-list");
  const visibleRepos = inboxGroups
    .map((g) => ({ group: g, matches: repoMatches(g, activeFilter) }))
    .filter((x) => x.matches.length);
  if (!visibleRepos.length) {
    repoList.innerHTML = `<li class="source-empty">No repositories yet.</li>`;
  } else {
    repoList.innerHTML = visibleRepos
      .map(({ group: g, matches }) => {
        const unread = matches.filter((n) => n.unread).length;
        const count = unread ? `<span class="source-count">${unread}</span>` : "";
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
    btn.classList.toggle("source--active", btn.dataset.filter === activeFilter);
  }
  for (const btn of $$(".source[data-repo]")) {
    btn.classList.toggle(
      "source--active",
      activeRepo != null && Number(btn.dataset.repo) === activeRepo,
    );
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
}

/** Toggle the repository refinement: select it, or clear it if already active. */
function selectRepo(repoId) {
  activeRepo = activeRepo === repoId ? null : repoId;
  showSettings(false);
  renderSidebar();
  renderInbox();
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

/* -------------------------------- Settings ------------------------------- */

/** Debounce timer for the polling-interval stepper (typed values settle before save). */
let settingsDebounce;

/** Monotonic token so only the latest save_settings response updates the UI (rapid
 * toggles/edits can otherwise let a slow, stale response overwrite newer state). */
let settingsApplySeq = 0;

async function loadSettings() {
  try {
    const s = await invoke("get_settings");
    $("#poll-interval").value = s.poll_interval_s;
    $("#dependabot-only").checked = s.dependabot_only;
    pollIntervalSeconds = s.poll_interval_s;
    clearSettingsError();
  } catch (err) {
    setSettingsError(String(err));
  }
}

/** Persist a validation/save error in the polling-interval row (stays until corrected). */
function setSettingsError(text) {
  const el = $("#settings-flash");
  el.textContent = text;
  clearTimeout(el._flashTimer);
  el.classList.add("srow-flash--error", "srow-flash--show");
}

function clearSettingsError() {
  const el = $("#settings-flash");
  el.classList.remove("srow-flash--error", "srow-flash--show");
}

/** Auto-apply: read the current controls, validate, persist, and confirm transiently. */
async function applySettings() {
  const pollIntervalS = Number.parseInt($("#poll-interval").value, 10);
  const dependabotOnly = $("#dependabot-only").checked;

  // Guard against NaN / out-of-range input before invoking the backend (NaN would
  // serialize to null over IPC and surface a confusing error).
  if (!Number.isInteger(pollIntervalS) || pollIntervalS < 10) {
    setSettingsError("Min 10s");
    return;
  }
  clearSettingsError();

  const seq = ++settingsApplySeq;
  try {
    const s = await invoke("save_settings", { pollIntervalS, dependabotOnly });
    // Ignore a stale response superseded by a newer apply, so it can't clobber the
    // current UI state or show an outdated flash.
    if (seq !== settingsApplySeq) return;
    // Reflect the toggle (the backend echoes the stored value) without clobbering the
    // number field while the user may still be typing in it.
    $("#dependabot-only").checked = s.dependabot_only;
    flash($("#settings-flash"), "Saved");
    // Adopt the new cadence immediately and restart the countdown so the change is
    // reflected without waiting out the previous interval.
    if (s.poll_interval_s !== pollIntervalSeconds) {
      pollIntervalSeconds = s.poll_interval_s;
      if (authenticated) startPolling();
    }
  } catch (err) {
    if (seq !== settingsApplySeq) return;
    setSettingsError(String(err));
  }
}

/* --------------------------------- Panes --------------------------------- */

/** Toggle between the notifications pane and the Settings pane (single window). */
function showSettings(show) {
  $("#view-notifications").hidden = show;
  $("#view-settings").hidden = !show;
}

/* ----------------------------- Sidebar resize ---------------------------- */

/** Make the sidebar width draggable. The CSS default is treated as the minimum;
 *  the chosen width is persisted across launches in localStorage. */
function initSidebarResize() {
  const resizer = $("#sidebar-resizer");
  if (!resizer) return;

  const root = document.documentElement;
  const min = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-w"), 10) || 232;
  const max = 520;
  const STEP = 16;
  let current = min;

  // Single entry point for width changes: clamp, apply, expose to AT, and persist.
  const setWidth = (w, persist = true) => {
    current = Math.max(min, Math.min(max, Math.round(w)));
    root.style.setProperty("--sidebar-w", `${current}px`);
    resizer.setAttribute("aria-valuenow", String(current));
    if (persist) localStorage.setItem("helix:sidebar-w", String(current));
  };

  resizer.setAttribute("aria-valuemin", String(min));
  resizer.setAttribute("aria-valuemax", String(max));

  const saved = Number.parseInt(localStorage.getItem("helix:sidebar-w"), 10);
  setWidth(Number.isFinite(saved) ? saved : min, false);

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    // The sidebar starts at the window's left edge, so its width === cursor X.
    setWidth(e.clientX, false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("sidebar-resizer--dragging");
    document.body.style.cursor = "";
    localStorage.setItem("helix:sidebar-w", String(current));
  };

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't start a text/window-drag interaction
    dragging = true;
    resizer.classList.add("sidebar-resizer--dragging");
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // A mouseup outside the webview is never delivered; terminate on blur so the
  // drag can't get stuck (cursor left as col-resize).
  window.addEventListener("blur", onUp);

  // Keyboard operability for the separator (arrows step, Home/End jump).
  resizer.addEventListener("keydown", (e) => {
    let next = current;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - STEP;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + STEP;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    setWidth(next);
  });

  // Double-click resets to the default (minimum) width.
  resizer.addEventListener("dblclick", () => setWidth(min));
}

/* --------------------------------- Init ---------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  // Settings auto-apply: the toggle persists immediately; the stepper debounces typed
  // values and persists right away on a committed change (blur / arrow click).
  $("#dependabot-only").addEventListener("change", applySettings);
  $("#poll-interval").addEventListener("input", () => {
    clearTimeout(settingsDebounce);
    settingsDebounce = setTimeout(applySettings, 450);
  });
  $("#poll-interval").addEventListener("change", () => {
    clearTimeout(settingsDebounce);
    applySettings();
  });
  for (const btn of $$(".js-sync-btn")) btn.addEventListener("click", syncNow);

  initSidebarResize();

  // Sidebar smart filters.
  for (const btn of $$(".source[data-filter]")) {
    btn.addEventListener("click", () => selectFilter(btn.dataset.filter));
  }

  // Settings pane: opened from the sidebar or ⌘, ; closed via the back button.
  $("#open-settings").addEventListener("click", () => showSettings(true));
  $("#settings-back").addEventListener("click", () => showSettings(false));
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      showSettings($("#view-settings").hidden);
    }
  });

  registerSyncEvents();
  loadStorage();
  loadSyncStatus();
  loadSettings();
  // Load the account first so the inbox knows whether to show its signed-out hint.
  loadAccount().finally(loadInbox);

  // The window starts hidden (see tauri.conf.json) to avoid a flash on launch;
  // reveal it from Rust now that the DOM is built and styled. We do not wait on
  // requestAnimationFrame: a hidden macOS WKWebView never paints, so its rAF
  // callbacks would never fire and the window would stay hidden forever. The Rust
  // safety-net (see lib.rs) reveals the window if this call ever fails.
  invoke("show_main_window").catch(() => {});
});

