const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/** True once the user is authenticated; drives the signed-out empty state. */
let authenticated = false;

const STATES = ["pending", "success", "error"];

/** True while a sync is in flight; gates stale sync:progress events. */
let syncing = false;

/** Apply a color-coded state (green/yellow/red) to a status dot + label. */
function setStatus(dotId, labelId, state, text) {
  const dot = $(dotId);
  const label = $(labelId);
  for (const s of STATES) {
    dot.classList.remove(`status-dot--${s}`);
    label.classList.remove(`status-label--${s}`);
  }
  dot.classList.add(`status-dot--${state}`);
  label.classList.add(`status-label--${state}`);
  label.textContent = text;
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
  setStatus("#status-dot", "#status-label", "pending", "Bootstrapping…");
  try {
    const status = await invoke("db_status");
    setStatus("#status-dot", "#status-label", "success", "Ready");
    const tables = status.tables.length
      ? status.tables.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("")
      : "<li><em>no tables</em></li>";
    $("#storage-body").innerHTML = `
      <dl class="kv">
        <dt>Database</dt>
        <dd><code>${escapeHtml(status.path)}</code></dd>
        <dt>Schema version</dt>
        <dd>v${escapeHtml(status.schema_version)}</dd>
        <dt>Tables</dt>
        <dd><ul class="tables">${tables}</ul></dd>
      </dl>`;
  } catch (err) {
    setStatus("#status-dot", "#status-label", "error", "Error");
    $("#storage-body").innerHTML = `
      <p class="error-text">Could not open the local database.</p>
      <pre class="error-detail">${escapeHtml(err)}</pre>`;
  }
}

/* -------------------------------- Account -------------------------------- */

function renderSignedIn(login) {
  authenticated = true;
  setStatus("#auth-dot", "#auth-label", "success", "Signed in");
  $("#account-body").innerHTML = `
    <div class="account-row">
      <div class="account-id">
        Signed in as <strong>@${escapeHtml(login)}</strong>
      </div>
      <button type="button" class="btn" id="sign-out">Sign out</button>
    </div>`;
  $("#sign-out").addEventListener("click", signOut);
}

function renderSignedOut(message) {
  authenticated = false;
  setStatus("#auth-dot", "#auth-label", "pending", "Not connected");
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
  setStatus("#auth-dot", "#auth-label", "pending", "Verifying…");
  msg.className = "form-msg";
  msg.textContent = "Verifying with GitHub…";

  try {
    const user = await invoke("sign_in", { token });
    renderSignedIn(user.login);
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
  setStatus("#auth-dot", "#auth-label", "pending", "Checking…");
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
    setStatus("#auth-dot", "#auth-label", "error", "Error");
    $("#account-body").innerHTML = `<pre class="error-detail">${escapeHtml(err)}</pre>`;
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
  $("#sync-stats").innerHTML = `
    <dt>Last sync</dt>
    <dd>${escapeHtml(fmtTimestamp(status.last_sync_at))}</dd>
    <dt>Stored notifications</dt>
    <dd>${escapeHtml(status.notification_count)}</dd>
    <dt>API rate remaining</dt>
    <dd>${escapeHtml(rate)}</dd>`;

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
  setSyncStatus("pending", "Syncing…");
  setSyncProgress("Starting…");

  try {
    const result = await invoke("sync_now");
    // Stop accepting progress updates before writing the final message, so a
    // late-delivered sync:progress event can't overwrite it.
    syncing = false;
    setSyncProgress(
      `Stored ${result.count} notification${result.count === 1 ? "" : "s"}.`,
      "success",
    );
    await loadSyncStatus();
    await loadInbox();
  } catch (err) {
    syncing = false;
    setSyncStatus("error", "Error");
    setSyncProgress(String(err), "error");
  } finally {
    syncing = false;
    setSyncBusy(false);
  }
}

/** Live progress from the backend during a sync. */
function registerSyncEvents() {
  listen("sync:progress", (event) => {
    // Ignore stale events delivered after the sync has settled.
    if (!syncing) return;
    const { page, fetched } = event.payload ?? {};
    setSyncProgress(`Fetching page ${page}… (${fetched} so far)`);
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
};

function subjectBadge(type) {
  const [label, cls] = SUBJECT_BADGES[type] ?? [type, "badge--other"];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function stateClass(state) {
  return (
    {
      merged: "merged",
      closed: "closed",
      open: "open",
      completed: "done",
      not_planned: "muted",
    }[state] ?? "muted"
  );
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
  const state = n.subject_state
    ? `<span class="state state--${stateClass(n.subject_state)}">${escapeHtml(
        n.subject_state,
      )}</span>`
    : "";
  const reason = escapeHtml(n.reason.replace(/_/g, " "));
  return `
    <li class="n-row ${n.unread ? "n-row--unread" : ""}">
      <span class="n-unread-dot" aria-hidden="true"></span>
      <span class="n-badge-slot">${subjectBadge(n.subject_type)}</span>
      <div class="n-main">
        <div class="n-title">${number}${escapeHtml(n.subject_title)} ${state}</div>
        <div class="n-meta">${reason} · ${escapeHtml(relTime(n.updated_at))}</div>
      </div>
    </li>`;
}

/* The sidebar drives a single active "source": either a smart filter (across all
 * repos) or a specific repository. Notifications are fetched once into `inboxGroups`
 * and re-rendered locally as the source changes. */

let inboxGroups = [];
let activeSource = { kind: "filter", id: "unread" };

/** Smart filters: predicate over a notification + the human label for the toolbar. */
const FILTERS = {
  unread: { label: "Unread", match: (n) => n.unread },
  all: { label: "All notifications", match: () => true },
  mention: { label: "Mentions", match: (n) => n.reason === "mention" },
  review_requested: {
    label: "Review requests",
    match: (n) => n.reason === "review_requested",
  },
  done: { label: "Done", match: (n) => !n.unread },
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

/** Apply the active source to `inboxGroups`, returning groups with matching rows. */
function filteredGroups() {
  if (activeSource.kind === "repo") {
    const group = inboxGroups.find((g) => g.repo_id === activeSource.id);
    return group ? [group] : [];
  }
  const match = (FILTERS[activeSource.id] ?? FILTERS.unread).match;
  return inboxGroups
    .map((g) => ({ ...g, notifications: g.notifications.filter(match) }))
    .filter((g) => g.notifications.length);
}

/** Current toolbar title for the active source. */
function activeTitle() {
  if (activeSource.kind === "repo") {
    const group = inboxGroups.find((g) => g.repo_id === activeSource.id);
    return group ? group.full_name : "Repository";
  }
  return (FILTERS[activeSource.id] ?? FILTERS.unread).label;
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

/** Render the main list for the active source. */
function renderInbox() {
  const inbox = $("#inbox");
  $("#view-title").textContent = activeTitle();
  const groups = filteredGroups();
  if (!groups.length) {
    inbox.innerHTML = emptyInbox();
    const goto = inbox.querySelector(".js-goto-settings");
    if (goto) goto.addEventListener("click", () => showSettings(true));
    return;
  }
  inbox.innerHTML = groups.map(repoSection).join("");
}

/** Update sidebar source selection styling + the smart-filter counts. */
function renderSidebar() {
  const all = inboxGroups.flatMap((g) => g.notifications);
  const counts = {
    unread: all.filter(FILTERS.unread.match).length,
    all: all.length,
    mention: all.filter(FILTERS.mention.match).length,
    review_requested: all.filter(FILTERS.review_requested.match).length,
    done: all.filter(FILTERS.done.match).length,
  };
  for (const el of $$(".source-count")) {
    const key = el.dataset.count;
    const value = counts[key] ?? 0;
    el.textContent = value ? String(value) : "";
  }

  // Repositories list (selectable sources), ordered like the inbox.
  const repoList = $("#repo-list");
  if (!inboxGroups.length) {
    repoList.innerHTML = `<li class="source-empty">No repositories yet.</li>`;
  } else {
    repoList.innerHTML = inboxGroups
      .map((g) => {
        const unread = g.notifications.filter((n) => n.unread).length;
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
      btn.addEventListener("click", () =>
        selectSource({ kind: "repo", id: Number(btn.dataset.repo) }),
      );
    }
  }

  // Reflect the active selection across both source groups.
  for (const btn of $$(".source[data-filter], .source[data-repo]")) {
    const isActive =
      (btn.dataset.filter &&
        activeSource.kind === "filter" &&
        btn.dataset.filter === activeSource.id) ||
      (btn.dataset.repo &&
        activeSource.kind === "repo" &&
        Number(btn.dataset.repo) === activeSource.id);
    btn.classList.toggle("source--active", Boolean(isActive));
  }
}

/** Switch the active source and re-render the list + sidebar selection. */
function selectSource(source) {
  activeSource = source;
  showSettings(false);
  renderSidebar();
  renderInbox();
}

async function loadInbox() {
  try {
    inboxGroups = await invoke("list_inbox");
    renderSidebar();
    renderInbox();
  } catch (err) {
    $("#inbox").innerHTML = `<pre class="error-detail">${escapeHtml(err)}</pre>`;
  }
}

/* -------------------------------- Settings ------------------------------- */
async function loadSettings() {
  setStatus("#settings-dot", "#settings-label", "pending", "Loading…");
  try {
    const s = await invoke("get_settings");
    $("#poll-interval").value = s.poll_interval_s;
    $("#dependabot-only").checked = s.dependabot_only;
    setStatus("#settings-dot", "#settings-label", "success", "Saved");
    $("#settings-msg").textContent = "";
  } catch (err) {
    setStatus("#settings-dot", "#settings-label", "error", "Error");
    $("#settings-msg").className = "form-msg form-msg--error";
    $("#settings-msg").textContent = String(err);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const btn = $("#settings-save");
  const msg = $("#settings-msg");
  const pollIntervalS = Number.parseInt($("#poll-interval").value, 10);
  const dependabotOnly = $("#dependabot-only").checked;

  // Guard against NaN / out-of-range input before invoking the backend (NaN would
  // serialize to null over IPC and surface a confusing error).
  if (!Number.isInteger(pollIntervalS) || pollIntervalS < 10) {
    setStatus("#settings-dot", "#settings-label", "error", "Error");
    msg.className = "form-msg form-msg--error";
    msg.textContent = "Enter a whole number of seconds (10 or more).";
    return;
  }

  btn.disabled = true;
  setStatus("#settings-dot", "#settings-label", "pending", "Saving…");
  msg.className = "form-msg";
  msg.textContent = "Saving…";

  try {
    const s = await invoke("save_settings", {
      pollIntervalS,
      dependabotOnly,
    });
    $("#poll-interval").value = s.poll_interval_s;
    $("#dependabot-only").checked = s.dependabot_only;
    setStatus("#settings-dot", "#settings-label", "success", "Saved");
    msg.className = "form-msg form-msg--success";
    msg.textContent = "Settings saved.";
  } catch (err) {
    setStatus("#settings-dot", "#settings-label", "error", "Error");
    msg.className = "form-msg form-msg--error";
    msg.textContent = String(err);
  } finally {
    btn.disabled = false;
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
  const setWidth = (w) =>
    root.style.setProperty("--sidebar-w", `${Math.max(min, Math.min(max, w))}px`);

  const saved = Number.parseInt(localStorage.getItem("helix:sidebar-w"), 10);
  if (Number.isFinite(saved)) setWidth(saved);

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    // The sidebar starts at the window's left edge, so its width === cursor X.
    setWidth(e.clientX);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("sidebar-resizer--dragging");
    document.body.style.cursor = "";
    const w = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-w"), 10);
    if (Number.isFinite(w)) localStorage.setItem("helix:sidebar-w", String(w));
  };

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't start a text/window-drag interaction
    dragging = true;
    resizer.classList.add("sidebar-resizer--dragging");
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // Double-click resets to the default (minimum) width.
  resizer.addEventListener("dblclick", () => {
    root.style.setProperty("--sidebar-w", `${min}px`);
    localStorage.setItem("helix:sidebar-w", String(min));
  });
}

/* --------------------------------- Init ---------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  $("#settings-form").addEventListener("submit", saveSettings);
  for (const btn of $$(".js-sync-btn")) btn.addEventListener("click", syncNow);

  initSidebarResize();

  // Sidebar smart filters.
  for (const btn of $$(".source[data-filter]")) {
    btn.addEventListener("click", () =>
      selectSource({ kind: "filter", id: btn.dataset.filter }),
    );
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

