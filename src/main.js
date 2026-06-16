const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);

const STATES = ["pending", "success", "error"];

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
    setStatus("#sync-dot", "#sync-label", "error", "Error");
    $("#sync-progress").className = "form-msg form-msg--error";
    $("#sync-progress").textContent = status.last_error;
  } else if (status.last_status === "success") {
    setStatus("#sync-dot", "#sync-label", "success", "Synced");
  } else {
    setStatus("#sync-dot", "#sync-label", "pending", "Never synced");
  }
}

async function loadSyncStatus() {
  setStatus("#sync-dot", "#sync-label", "pending", "Loading…");
  try {
    const status = await invoke("sync_status");
    renderSyncStats(status);
  } catch (err) {
    setStatus("#sync-dot", "#sync-label", "error", "Error");
    $("#sync-progress").className = "form-msg form-msg--error";
    $("#sync-progress").textContent = String(err);
  }
}

async function syncNow() {
  const btn = $("#sync-btn");
  const progress = $("#sync-progress");
  btn.disabled = true;
  setStatus("#sync-dot", "#sync-label", "pending", "Syncing…");
  progress.className = "form-msg";
  progress.textContent = "Starting…";

  try {
    const result = await invoke("sync_now");
    progress.className = "form-msg form-msg--success";
    progress.textContent = `Stored ${result.count} notification${
      result.count === 1 ? "" : "s"
    }.`;
    await loadSyncStatus();
  } catch (err) {
    setStatus("#sync-dot", "#sync-label", "error", "Error");
    progress.className = "form-msg form-msg--error";
    progress.textContent = String(err);
  } finally {
    btn.disabled = false;
  }
}

/** Live progress from the backend during a sync. */
function registerSyncEvents() {
  listen("sync:progress", (event) => {
    const { page, fetched } = event.payload ?? {};
    const progress = $("#sync-progress");
    progress.className = "form-msg";
    progress.textContent = `Fetching page ${page}… (${fetched} so far)`;
  });
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

/* --------------------------------- Init ---------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  $("#settings-form").addEventListener("submit", saveSettings);
  $("#sync-btn").addEventListener("click", syncNow);
  registerSyncEvents();
  loadStorage();
  loadAccount();
  loadSyncStatus();
  loadSettings();
});
