const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ----------------------------- Tunables ---------------------------------- */
/* Named knobs gathered here so behavior isn't tuned via scattered magic numbers.
   The poll-interval floor is NOT here on purpose — it's owned by the Rust backend
   (`get_settings().min_poll_interval_s`) so the UI can't drift from it. */

/** Automatic-poll heartbeat: how often `pollTick` runs (ms). */
const POLL_TICK_MS = 1000;
/** Polling cadence (s) assumed until the saved setting loads. */
const DEFAULT_POLL_INTERVAL_S = 60;
/** Fallback poll-interval floor used only until/if `loadSettings()` provides the
 *  authoritative `min_poll_interval_s` from the backend. Mirrors the Rust default. */
const FALLBACK_MIN_POLL_INTERVAL_S = 10;

/** Auto-dismiss timings (ms) for transient feedback. */
const FLASH_DISMISS_MS = 1800;
const TOAST_DISMISS_MS = 1600;
const SYNC_PROGRESS_DISMISS_MS = 2600;

/** Sidebar resize bounds (px). The minimum falls back to the CSS `--sidebar-w`. */
const SIDEBAR_MIN_FALLBACK_PX = 232;
const SIDEBAR_MAX_PX = 520;
const SIDEBAR_KEY_STEP_PX = 16;

/** Debounce (ms) before persisting a typed polling-interval value. */
const SETTINGS_DEBOUNCE_MS = 450;

/** True once the user is authenticated; drives the signed-out empty state. */
let authenticated = false;

/** True when the backend stores the PAT unencrypted in SQLite (debug builds) rather than
 *  the Keychain; drives the Settings warning. Set from `auth_status` in `loadAccount`. */
let unencryptedStorage = false;

const STATES = ["pending", "success", "error", "neutral"];

/** True while a sync is in flight; gates stale sync:progress events. */
let syncing = false;

/** True once a sync has succeeded *in this session*. Until then the status pill stays
 *  neutral: at launch we only show cached local state and haven't confirmed Keychain or
 *  network access, so an affirmative green "Synced" would be misleading. */
let syncedThisSession = false;

/** Timer that clears the transient post-sync "Stored N" progress message. */
let syncProgressTimer;

/* ----------------------------- Poll state -------------------------------- */

/** 1-second tick driving the automatic poll + the refresh-button clock sweep. */
let pollTimer = null;
/** Configured polling cadence (seconds); kept in sync with the saved setting. */
let pollIntervalSeconds = DEFAULT_POLL_INTERVAL_S;
/** Floor for the poll interval. Authoritative value comes from the backend
 *  (`get_settings().min_poll_interval_s`); this is just a fallback until settings load. */
let minPollIntervalS = FALLBACK_MIN_POLL_INTERVAL_S;
/** Seconds elapsed since the last sync; reset to 0 after every sync. */
let pollElapsed = 0;

/* ----------------------------- Theme state ------------------------------- */

/** Appearance preference: "system" | "light" | "dark". Source of truth is SQLite
 *  (loaded via get_settings); mirrored to localStorage for the no-FOUC head script. */
let themePref = "system";
const darkMql = window.matchMedia("(prefers-color-scheme: dark)");

/** Resolve a preference to the concrete theme to paint ("light" | "dark"). */
function resolveTheme(pref) {
  if (pref === "dark" || pref === "light") return pref;
  return darkMql.matches ? "dark" : "light";
}

/** Paint the webview for a preference (data-theme + module state) without persisting.
 *  Used for optimistic feedback before a save round-trips. */
function paintThemePref(pref) {
  themePref = pref;
  document.documentElement.dataset.theme = resolveTheme(pref);
}

/** Mirror the preference to localStorage for the no-FOUC head script. Only called once
 *  the value is known to match SQLite (on load or after a successful save), so the cache
 *  never diverges from the persisted source of truth. */
function mirrorThemePref(pref) {
  try {
    localStorage.setItem("helix-theme", pref);
  } catch (e) {
    /* localStorage unavailable — the setting still persists in SQLite. */
  }
}

// In "system" mode, follow live OS appearance changes. `addEventListener` on a
// MediaQueryList is unavailable on the oldest supported WebKit (macOS 10.15 / Safari
// 13), so fall back to the deprecated `addListener`.
function onColorSchemeChange() {
  if (themePref === "system") {
    document.documentElement.dataset.theme = resolveTheme("system");
  }
}
if (darkMql.addEventListener) {
  darkMql.addEventListener("change", onColorSchemeChange);
} else if (darkMql.addListener) {
  darkMql.addListener(onColorSchemeChange);
}

/** Latest desired preference awaiting persistence, and the in-flight save runner.
 *  Together they serialize theme saves and coalesce rapid toggles to the last choice. */
let themePending = null;
let themeSaveRunner = null;

/** Re-sync the picker + paint from SQLite (the source of truth). Used to recover after a
 *  failed save rather than trusting a possibly-stale in-memory value. */
async function resyncThemeFromBackend() {
  try {
    const s = await invoke("get_settings");
    const input = $(`input[name="theme"][value="${s.theme}"]`);
    if (input) input.checked = true;
    paintThemePref(s.theme);
    mirrorThemePref(s.theme);
  } catch (e) {
    /* Best-effort recovery; leave the optimistic paint in place. */
  }
}

/** Paint the chosen theme immediately, then persist it. Saves are serialized (one
 *  `set_theme` in flight at a time) and coalesced to the latest selection, so rapid
 *  toggles can't let a slower earlier write land last in SQLite. Persistence is
 *  independent of the rest of the settings form (a mid-edit poll interval can't block
 *  it). On failure the UI re-syncs from the persisted value. */
async function persistTheme(pref) {
  paintThemePref(pref);
  themePending = pref;
  if (themeSaveRunner) return; // an active runner will pick up the latest themePending

  themeSaveRunner = (async () => {
    try {
      while (themePending !== null) {
        const target = themePending;
        themePending = null;
        await invoke("set_theme", { theme: target });
        // Only mirror once this is the settled choice (nothing newer queued meanwhile).
        if (themePending === null) mirrorThemePref(target);
      }
    } catch (err) {
      themePending = null;
      setSettingsError(String(err));
      await resyncThemeFromBackend();
    } finally {
      themeSaveRunner = null;
    }
  })();
}

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
  }, FLASH_DISMISS_MS);
}

/** Show a brief, self-dismissing toast for actions with no inline anchor (e.g. a copy
 * triggered from the right-click menu). Announced politely for screen readers. */
let toastTimer = null;
function toast(text, kind) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("toast--error", kind === "error");
  // Restart the CSS transition even if a toast is already showing.
  el.classList.remove("toast--show");
  void el.offsetWidth;
  el.classList.add("toast--show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("toast--show"), TOAST_DISMISS_MS);
}

/** Announce a concise message to assistive tech via the visually-hidden live region.
 *  The inbox is not itself a live region (it re-renders wholesale), so user-meaningful
 *  transitions — filter changes, mark-done outcomes — are surfaced here instead. Re-sets
 *  identical text by clearing first so repeated messages still announce. */
function announce(text) {
  const el = $("#a11y-announcer");
  if (!el) return;
  el.textContent = "";
  // Re-set on the next frame: clearing then setting on a separate frame re-triggers the
  // live region even when the text is identical to the previous announcement.
  requestAnimationFrame(() => {
    el.textContent = text;
  });
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

/** Copy `text` to the clipboard, returning whether it succeeded. Tries the async Clipboard
 *  API first, then falls back to a hidden-textarea `execCommand("copy")` — the async API is
 *  unavailable/blocked in the macOS WKWebView Tauri uses, so the fallback is what actually
 *  runs there. */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it out of view and inert, but selectable so `execCommand("copy")` has a target.
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } finally {
      ta.remove();
    }
  } catch {
    return false;
  }
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
      if (await copyText(path)) {
        flash($("#db-copy-flash"), "Copied");
      } else {
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

/** Markup for the "token stored unencrypted" warning shown in debug builds, or "" in
 *  release. Rendered inside the Account group so it sits next to the credential UI. */
function unencryptedStorageWarning() {
  if (!unencryptedStorage) return "";
  return `
    <div class="callout callout--warn" role="note">
      <strong>Dev build:</strong> your GitHub token is stored
      <strong>unencrypted</strong> in this app's local database (SQLite), not the macOS
      Keychain. Use a low-privilege token and don't ship this build.
    </div>`;
}

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
    ${unencryptedStorageWarning()}
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
  // A new session must re-prove a successful sync before the status pill goes green
  // again, so a stale persisted "success" doesn't show as green after re-signing in.
  syncedThisSession = false;
  // Signed out → stop polling so we never hit the API without a token.
  stopPolling();
  $("#account-body").innerHTML = `
    ${unencryptedStorageWarning()}
    <form id="signin-form" class="form">
      <div class="field">
        <label for="pat">GitHub Personal Access Token</label>
        <input id="pat" name="pat" type="password" autocomplete="off"
          placeholder="ghp_… or github_pat_…" />
        <p class="hint">
          Needs the <code>notifications</code> scope (add <code>repo</code> for private
          repositories). ${
            unencryptedStorage
              ? "Stored <strong>unencrypted</strong> in this app's local database (dev build)."
              : "Stored in your macOS Keychain."
          }
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
  const body = $("#account-body");
  body.classList.remove("slist--error");
  try {
    const status = await invoke("auth_status");
    unencryptedStorage = Boolean(status.unencrypted_storage);
    // The "stored in the macOS Keychain" footer is only true for release builds.
    const keychainNote = $("#keychain-note");
    if (keychainNote) keychainNote.hidden = unencryptedStorage;
    if (status.authenticated && status.login) {
      renderSignedIn(status.login);
    } else if (status.authenticated) {
      renderSignedIn("(unknown)");
    } else {
      renderSignedOut();
    }
  } catch (err) {
    body.classList.add("slist--error");
    body.innerHTML = `<div class="srow"><span class="srow-error">${escapeHtml(err)}</span></div>`;
  }
}

/* ------------------------------ Notifications ----------------------------- */

function fmtTimestamp(value) {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/* Human label for a GitHub rate-limit bucket. Falls back to the raw resource name (which
 * is escaped before insertion) so a future/unknown bucket still renders sensibly. */
const RATE_BUCKET_LABELS = {
  core: "Core (REST)",
  search: "Search",
  graphql: "GraphQL",
  integration_manifest: "Integration manifest",
  source_import: "Source import",
  code_scanning_upload: "Code scanning upload",
  code_search: "Code search",
};

function rateBucketLabel(resource) {
  return RATE_BUCKET_LABELS[resource] || resource;
}

/* Countdown to a rate-limit window reset, given as epoch seconds. Future-facing
 * complement to relTime ("resets in 12m" / "resets now"). */
function resetCountdown(epochSeconds) {
  if (epochSeconds == null) return "";
  const secs = Math.floor(epochSeconds - Date.now() / 1000);
  if (secs <= 0) return "resets now";
  const m = Math.floor(secs / 60);
  if (m < 1) return `resets in ${secs}s`;
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `resets in ${h}h` : `resets in ${Math.floor(h / 24)}d`;
}

/* Render one usage bar per rate-limit bucket. The bar fills with how much of the token's
 * allowance is *used* (limit − remaining), turning amber/red as it approaches the cap. */
function renderRateBuckets(buckets) {
  const host = $("#rate-buckets");
  if (!host) return;

  if (!buckets.length) {
    host.innerHTML =
      '<div class="srow"><span class="srow-value srow-muted">No requests yet.</span></div>';
    return;
  }

  host.innerHTML = buckets
    .map((b) => {
      const label = escapeHtml(rateBucketLabel(b.resource));
      const hasNums = b.limit != null && b.remaining != null && b.limit > 0;

      // Without limit/remaining we genuinely don't know usage — render an inert,
      // unlabelled track rather than a misleading "0% used" progressbar.
      if (!hasNums) {
        return `
        <div class="rate-row">
          <div class="rate-head">
            <span class="rate-name">${label}</span>
            <span class="rate-counts">—</span>
          </div>
          <div class="rate-bar rate-bar--unknown"></div>
          <div class="rate-foot">
            <span class="rate-used">usage unknown</span>
            <span class="rate-reset">${escapeHtml(resetCountdown(b.reset_at))}</span>
          </div>
        </div>`;
      }

      // Once the window's reset time has passed, the stored snapshot is stale: GitHub has
      // rolled the bucket over and refilled it, so render it as reset (full / 0% used)
      // rather than alarming red, until the next request refreshes the real numbers.
      const expired = b.reset_at != null && b.reset_at <= Date.now() / 1000;
      const remaining = expired ? b.limit : b.remaining;
      const used = Math.max(0, b.limit - remaining);
      const frac = Math.min(1, Math.max(0, used / b.limit));
      const pct = Math.round(frac * 100);
      const level = frac >= 0.9 ? "danger" : frac >= 0.75 ? "warn" : "ok";
      const counts = `${remaining.toLocaleString()} / ${b.limit.toLocaleString()} left`;
      const reset = escapeHtml(expired ? "window reset" : resetCountdown(b.reset_at));
      return `
        <div class="rate-row">
          <div class="rate-head">
            <span class="rate-name">${label}</span>
            <span class="rate-counts">${escapeHtml(counts)}</span>
          </div>
          <div class="rate-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${label} usage">
            <div class="rate-fill rate-fill--${level}" style="width: ${pct}%"></div>
          </div>
          <div class="rate-foot">
            <span class="rate-used">${pct}% used</span>
            <span class="rate-reset">${reset}</span>
          </div>
        </div>`;
    })
    .join("");
}

function renderSyncStats(status) {
  const lastEl = $("#last-synced");
  if (lastEl) lastEl.textContent = fmtTimestamp(status.last_sync_at);
  renderRateBuckets(status.rate_buckets || []);

  if (status.last_status === "error" && status.last_error) {
    setSyncStatus("error", "Error");
    setSyncProgress(status.last_error, "error");
  } else if (status.last_status === "success") {
    // Green only confirms a sync that happened in this session. On launch we're showing
    // cached local state, so the same "success" record renders neutral with its age.
    const label = status.last_sync_at
      ? `Synced ${relTime(status.last_sync_at)}`
      : "Synced";
    setSyncStatus(syncedThisSession ? "success" : "neutral", label);
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
    syncedThisSession = true;
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
    syncProgressTimer = setTimeout(() => setSyncProgress(""), SYNC_PROGRESS_DISMISS_MS);
    await loadSyncStatus();
    await loadInbox();
    // A successful sync proves the Keychain is now readable, so refresh the account
    // section to clear any stale "failed to read token" error from an earlier cancel.
    await loadAccount();
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
  const interval = Math.max(pollIntervalSeconds, minPollIntervalS);
  setPollProgress(Math.min(pollElapsed / interval, 1));
  if (pollElapsed >= interval) syncNow();
}

/** Begin (or restart) the automatic poll loop. Safe to call repeatedly. */
function startPolling() {
  stopPolling();
  resetPollCountdown();
  pollTimer = setInterval(pollTick, POLL_TICK_MS);
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
  cleanup: { label: "Cleanup", match: (n) => isCleanupCandidate(n) },
};

/** Per-filter subtitle for the (illustrated) empty state. The title is always the same
 *  small "you're caught up" win; the subtitle says specifically what's empty. */
const EMPTY_SUBTITLES = {
  all: "No notifications right now.",
  mention: "No mentions right now.",
  team_mention: "No team mentions right now.",
  review_requested: "No review requests right now.",
  assign: "Nothing's assigned to you right now.",
  cleanup: "No stale subscriptions to clean.",
};

/** Cleanup candidates: notifications safe to mark as done (design.md §6). A merged or
 *  closed pull request, or a closed issue. Subjects that aren't yet resolved (no
 *  `subject_state`) and other subject types are excluded. The resolved state is only
 *  trusted when it reflects the latest thread activity (`updated_at <= resolved_at`,
 *  mirroring the backend's staleness rule) — so a subject that changed since we last
 *  resolved it (e.g. a reopened issue) is excluded until re-resolution catches up, and we
 *  never offer a stale candidate to clear. */
function isCleanupCandidate(n) {
  if (!n.resolved_at || n.updated_at > n.resolved_at) return false;
  if (n.subject_type === "PullRequest") {
    return n.subject_state === "merged" || n.subject_state === "closed";
  }
  if (n.subject_type === "Issue") {
    return n.subject_state === "closed";
  }
  return false;
}

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

/** Notifications in `group` matching the given type filter. */
function repoMatches(group, filterId) {
  const match = (FILTERS[filterId] ?? FILTERS.all).match;
  return group.notifications.filter(match);
}

/** Most recent `updated_at` in a notification list (ISO-8601 UTC strings compare lexically,
 *  so the newest is the max). Empty list → "". */
function latestUpdatedAt(notifications) {
  let max = "";
  for (const n of notifications) {
    if (n.updated_at > max) max = n.updated_at;
  }
  return max;
}

/** Order repo-like items most-recent-first by their newest (matching) notification, with
 *  repo name as a deterministic tie-breaker. Recency is computed once per item (not on every
 *  comparison), and names compare by code point so the order is stable across locales. */
function sortReposByRecency(items, getNotifications, getName) {
  return items
    .map((item) => ({
      item,
      recency: latestUpdatedAt(getNotifications(item)),
      name: getName(item),
    }))
    .sort((a, b) => {
      if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    })
    .map((x) => x.item);
}

/** Apply the active filter, then the optional repo refinement, to `inboxGroups`, ordering
 *  the repos most-recent-first. */
function filteredGroups() {
  let groups = inboxGroups
    .map((g) => ({ ...g, notifications: repoMatches(g, activeFilter) }))
    .filter((g) => g.notifications.length);
  if (activeRepo != null) {
    groups = groups.filter((g) => g.repo_id === activeRepo);
  }
  // Bubble the repo with the most recently updated matching notification to the top.
  return sortReposByRecency(groups, (g) => g.notifications, (g) => g.full_name);
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
    // Cancel any pending "clear" timer from an earlier success so it can't wipe this
    // error message out from under the user.
    clearTimeout(syncProgressTimer);
    setSyncProgress(
      `${result.ok} ${verb}, ${failed.length} failed: ${failed[0].error}`,
      "error",
    );
  } else if (result.ok > 0) {
    setSyncProgress(`${result.ok} ${verb}.`, "success");
    clearTimeout(syncProgressTimer);
    syncProgressTimer = setTimeout(() => setSyncProgress(""), SYNC_PROGRESS_DISMISS_MS);
  }
}

/** Mark the given thread ids as done: optimistically remove them, call the backend, then
 *  reconcile from SQLite. */
async function markDone(threadIds) {
  if (!authenticated) {
    clearTimeout(syncProgressTimer);
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
    // Cancel any pending "clear" timer so it can't wipe this error out moments later.
    clearTimeout(syncProgressTimer);
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

/** The open popover menu element, if any (single-instance; closed on any outside action). */
let openMenu = null;
/** The element that had focus before the menu opened, so focus can return there on close
 *  (otherwise removing the focused menu item dumps focus to <body>). */
let menuReturnFocus = null;

/** Close the open menu. By default returns focus to wherever it was before the menu opened;
 *  pass `restoreFocus = false` when immediately reopening, to avoid a focus flicker. */
function closeMenu(restoreFocus = true) {
  if (!openMenu) return;
  const menu = openMenu;
  // Clear the handle first so the focusout fired while detaching the menu is a no-op
  // (removing a focused element blurs it synchronously, which would re-enter here).
  openMenu = null;
  menu.removeEventListener("focusout", onMenuFocusOut);
  menu.remove();
  document.removeEventListener("keydown", onMenuKeydown, true);
  // Reflect the collapsed state on the toolbar trigger for assistive tech.
  $("#mark-all-done-btn")?.setAttribute("aria-expanded", "false");
  const target = menuReturnFocus;
  if (restoreFocus) {
    menuReturnFocus = null;
    if (target && document.contains(target)) target.focus();
  }
}

function onMenuKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
    return;
  }
  if (!openMenu) return;
  // ARIA menu semantics: arrow keys (and Home/End) move between enabled items.
  const items = [...openMenu.querySelectorAll(".context-menu-item:not(:disabled)")];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown") next = items[idx < 0 ? 0 : (idx + 1) % items.length];
  else if (e.key === "ArrowUp")
    next = items[idx <= 0 ? items.length - 1 : idx - 1];
  else if (e.key === "Home") next = items[0];
  else if (e.key === "End") next = items[items.length - 1];
  else if (e.key === "Tab") {
    // Trap Tab within the popover (wrapping at the ends) so keyboard focus can't escape to
    // the page behind it; Escape / outside-click / an item activation are the ways out.
    e.preventDefault();
    const step = e.shiftKey ? -1 : 1;
    next = items[(idx < 0 ? 0 : idx + step + items.length) % items.length];
  }
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/** Close the menu when focus genuinely moves to another element outside it (e.g. VoiceOver
 *  navigating to a different control). Deliberately ignores a null `relatedTarget`: on macOS
 *  WKWebView a <button> blurs to <body> on **mousedown** — firing `focusout` BEFORE its
 *  `click` — so closing on that would remove the item and swallow the click (the action
 *  would never run). Plain outside clicks are dismissed by the document `mousedown` listener,
 *  and Escape / scroll / window-blur also close the menu. */
function onMenuFocusOut(e) {
  if (!openMenu) return;
  const to = e.relatedTarget;
  if (!to) return; // focus fell to <body> (incl. the WKWebView mousedown blur) — keep open
  if (openMenu.contains(to)) return; // moved between items (arrow keys / Tab trap) — keep open
  // Focus moving to the mark-all trigger means the user clicked it to toggle the menu
  // closed; let that click handler do it, so we don't close-then-immediately-reopen.
  if (to.closest?.("#mark-all-done-btn")) return;
  closeMenu(false);
  // Focus has already left for good, so drop the pre-menu focus reference rather than
  // holding a stale node until the next menu opens.
  menuReturnFocus = null;
}

/** Open a popover menu of `items` ({ label, danger?, disabled?, action }) anchored at the
 *  given viewport point, clamped to stay on-screen. */
function openContextMenu(x, y, items) {
  // Capture the pre-menu focus target before we move focus into the popover. When a menu
  // is already open (reopening), keep the original target and close without restoring it,
  // so focus lands directly in the new menu rather than flickering back to the trigger.
  const reopening = openMenu != null;
  const previouslyFocused = document.activeElement;
  closeMenu(false);
  if (!reopening) {
    menuReturnFocus =
      previouslyFocused instanceof HTMLElement ? previouslyFocused : null;
  }
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `context-menu-item${item.danger ? " context-menu-item--danger" : ""}`;
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
    }
    menu.appendChild(btn);
  }
  // Place off-screen first to measure, then clamp into the viewport.
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  document.addEventListener("keydown", onMenuKeydown, true);
  // Close if focus leaves the popover entirely (Tab is trapped, but AT or programmatic
  // moves can still pull focus out).
  menu.addEventListener("focusout", onMenuFocusOut);
  // Move focus into the menu so keyboard users land in the popover (the trigger, e.g. the
  // ••• button, otherwise keeps focus and Tab never reaches it). Escape closes the menu.
  menu.querySelector(".context-menu-item:not(:disabled)")?.focus();
}

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

/** Debounce timer for the polling-interval stepper (typed values settle before save). */
let settingsDebounce;

/** Monotonic token so only the latest save_settings response updates the UI (rapid
 * toggles/edits can otherwise let a slow, stale response overwrite newer state). */
let settingsApplySeq = 0;

/** Apply the poll-interval floor to local state, the input's `min`, and the note text.
 *  Used at init with the fallback, then by `loadSettings()` with the backend's value.
 *  Guards against a missing/non-numeric value so the clamp can never become NaN. */
function applyPollMin(seconds) {
  minPollIntervalS = Number.isInteger(seconds)
    ? seconds
    : FALLBACK_MIN_POLL_INTERVAL_S;
  const input = $("#poll-interval");
  if (input) input.min = String(minPollIntervalS);
  const label = $("#poll-min-label");
  if (label) label.textContent = String(minPollIntervalS);
}

async function loadSettings() {
  try {
    const s = await invoke("get_settings");
    // The backend owns the floor; mirror it onto the input + local validation.
    applyPollMin(s.min_poll_interval_s);
    $("#poll-interval").value = s.poll_interval_s;
    pollIntervalSeconds = s.poll_interval_s;
    const themeInput = $(`input[name="theme"][value="${s.theme}"]`);
    if (themeInput) themeInput.checked = true;
    paintThemePref(s.theme);
    mirrorThemePref(s.theme);
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
  // Bump the sequence first so that even an invalid attempt supersedes any older
  // in-flight save — its late response must not flash "Saved" or clear this error.
  const seq = ++settingsApplySeq;

  const pollIntervalS = Number.parseInt($("#poll-interval").value, 10);

  // Guard against NaN / out-of-range input before invoking the backend (NaN would
  // serialize to null over IPC and surface a confusing error).
  if (!Number.isInteger(pollIntervalS) || pollIntervalS < minPollIntervalS) {
    setSettingsError(`Min ${minPollIntervalS}s`);
    return;
  }
  clearSettingsError();

  try {
    const s = await invoke("save_settings", { pollIntervalS });
    // Ignore a stale response superseded by a newer apply, so it can't clobber the
    // current UI state or show an outdated flash.
    if (seq !== settingsApplySeq) return;
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

/* -------------------------------- Updates ------------------------------- */

/** True when this build ships the auto-updater (release macOS only). Set in initUpdates. */
let updaterEnabled = false;
/** The running app version string (e.g. "0.1.0"). */
let appVersion = "";
/** Metadata for an available update ({version, current_version, notes}), or null. */
let availableUpdate = null;
/** True while an update is downloading/installing, to lock out re-entrancy. */
let updateInstalling = false;

function setUpdateStatus(text) {
  const el = $("#update-status");
  if (el) el.textContent = text;
}

/** Bootstrap the update UI: read the build's updater capability + version, wire the
 *  Settings controls and the prompt banner, and (release only) auto-check on launch. */
async function initUpdates() {
  try {
    updaterEnabled = await invoke("updater_enabled");
  } catch {
    updaterEnabled = false;
  }
  try {
    appVersion = await invoke("app_version");
  } catch {
    appVersion = "";
  }
  const verEl = $("#app-version");
  if (verEl) verEl.textContent = appVersion ? `v${appVersion}` : "—";

  $("#update-later")?.addEventListener("click", dismissUpdateBanner);
  $("#update-now")?.addEventListener("click", runUpdateInstall);

  const checkBtn = $("#check-updates-btn");
  if (!updaterEnabled) {
    // No updater in this build: debug builds, or a (non-shipped) non-macOS build. Word the
    // status to match the actual reason rather than always blaming "dev builds".
    const isMac = navigator.userAgent.includes("Macintosh");
    setUpdateStatus(
      isMac ? "Updates are disabled in dev builds" : "Updates aren't available on this platform",
    );
    if (checkBtn) checkBtn.disabled = true;
    return;
  }

  checkBtn?.addEventListener("click", () => checkForUpdate(true));

  // Download progress + completion are driven by the Rust installer (see lib.rs).
  listen("update:progress", (e) => {
    const { downloaded, total } = e.payload ?? {};
    setUpdateProgress(downloaded, total);
  });
  listen("update:installed", () => {
    const t = $("#update-banner-text");
    if (t) t.textContent = "Update installed — restarting…";
  });

  // Auto-check on launch — silent unless an update is actually available.
  checkForUpdate(false);
}

/** Ask the backend whether a newer release exists. `manual` adds inline feedback for the
 *  Settings "Check for updates" button; the launch check stays silent when up to date. */
async function checkForUpdate(manual) {
  if (!updaterEnabled || updateInstalling) return;
  const btn = $("#check-updates-btn");
  if (btn) btn.disabled = true;
  if (manual) setUpdateStatus("Checking…");
  try {
    const info = await invoke("check_for_update");
    if (info) {
      onUpdateAvailable(info);
    } else {
      availableUpdate = null;
      hideUpdateBanner();
      // The launch check is silent unless an update is available: only the manual
      // "Check for updates" button reports an up-to-date / failed result inline.
      if (manual) {
        setUpdateStatus("Up to date");
        flash($("#update-flash"), "Up to date");
      }
    }
  } catch (err) {
    if (manual) {
      setUpdateStatus("Couldn't check for updates");
      flash($("#update-flash"), "Failed", "error");
    }
  } finally {
    if (btn && !updateInstalling) btn.disabled = false;
  }
}

function onUpdateAvailable(info) {
  availableUpdate = info;
  setUpdateStatus(`Update available: v${info.version}`);
  const text = $("#update-banner-text");
  if (text) text.textContent = `Helix v${info.version} is available.`;
  $("#update-bar").hidden = true;
  $("#update-bar-fill").style.width = "0%";
  const now = $("#update-now");
  now.disabled = false;
  now.textContent = "Update & restart";
  $("#update-later").hidden = false;
  $("#update-banner").hidden = false;
}

function setUpdateProgress(downloaded, total) {
  $("#update-bar").hidden = false;
  const text = $("#update-banner-text");
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((downloaded / total) * 100));
    $("#update-bar-fill").style.width = `${pct}%`;
    if (text) text.textContent = `Downloading update… ${pct}%`;
  } else if (text) {
    text.textContent = "Downloading update…";
  }
}

/** Download + install the update, then relaunch (the backend restarts the app on success,
 *  tearing down this page). On failure, restore the prompt and surface the error. */
async function runUpdateInstall() {
  if (!updaterEnabled || updateInstalling || !availableUpdate) return;
  updateInstalling = true;
  const now = $("#update-now");
  now.disabled = true;
  $("#update-later").hidden = true;
  $("#update-bar").hidden = false;
  $("#update-bar-fill").style.width = "0%";
  $("#update-banner-text").textContent = "Downloading update…";
  if ($("#check-updates-btn")) $("#check-updates-btn").disabled = true;
  try {
    await invoke("install_update");
    // Success relaunches the app; nothing below runs.
  } catch (err) {
    updateInstalling = false;
    $("#update-banner-text").textContent = "Update failed.";
    $("#update-bar").hidden = true;
    now.disabled = false;
    $("#update-later").hidden = false;
    if ($("#check-updates-btn")) $("#check-updates-btn").disabled = false;
    toast(String(err), "error");
  }
}

/** Dismiss the prompt banner. The update stays reachable from Settings → Updates. */
function dismissUpdateBanner() {
  if (updateInstalling) return;
  hideUpdateBanner();
}

function hideUpdateBanner() {
  const b = $("#update-banner");
  if (b) b.hidden = true;
}

/** Toggle between the notifications pane and the Settings pane (single window). */
function showSettings(show) {
  // Detect an actual pane transition: selectFilter/selectRepo call showSettings(false)
  // while already in Notifications, and we must not steal focus in that case.
  const wasShown = !$("#view-settings").hidden;
  $("#view-notifications").hidden = show;
  $("#view-settings").hidden = !show;
  // Settings is a focused, full-width pane: hide the sidebar (and its resizer) so the
  // content spans the whole window. CSS also insets the toolbar past the traffic lights.
  document.querySelector(".app")?.classList.toggle("app--settings", show);
  if (show === wasShown) return;
  // The sidebar (and its #open-settings trigger) is hidden in Settings, so keyboard focus
  // would otherwise fall to <body>. Move focus to a sensible target on each transition:
  // into the pane when opening, back to the sidebar trigger when closing.
  if (show) {
    $("#settings-back")?.focus();
  } else {
    $("#open-settings")?.focus();
  }
}

/* ----------------------------- Sidebar resize ---------------------------- */

/** Make the sidebar width draggable. The CSS default is treated as the minimum;
 *  the chosen width is persisted across launches in localStorage. */
function initSidebarResize() {
  const resizer = $("#sidebar-resizer");
  if (!resizer) return;

  const root = document.documentElement;
  const min =
    parseInt(getComputedStyle(root).getPropertyValue("--sidebar-w"), 10) ||
    SIDEBAR_MIN_FALLBACK_PX;
  const max = SIDEBAR_MAX_PX;
  const STEP = SIDEBAR_KEY_STEP_PX;
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
  // Tag the platform so macOS-only chrome (e.g. the traffic-light toolbar inset) is scoped
  // to macOS and doesn't apply on Windows/Linux (the app bundles for all targets).
  if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.dataset.platform = "macos";
  }
  // Settings auto-apply: the stepper debounces typed values and persists right away on a
  // committed change (blur / arrow click).
  // Apply the fallback floor synchronously so the input has a sane `min` before the async
  // loadSettings() resolves with the backend's authoritative value.
  applyPollMin(FALLBACK_MIN_POLL_INTERVAL_S);
  $("#poll-interval").addEventListener("input", () => {
    clearTimeout(settingsDebounce);
    settingsDebounce = setTimeout(applySettings, SETTINGS_DEBOUNCE_MS);
  });
  $("#poll-interval").addEventListener("change", () => {
    clearTimeout(settingsDebounce);
    applySettings();
  });

  // Theme picker: paint + persist independently of the rest of the settings form, so
  // toggling theme always saves even if another field (e.g. poll interval) is mid-edit.
  for (const input of $$('input[name="theme"]')) {
    input.addEventListener("change", () => persistTheme(input.value));
  }
  for (const btn of $$(".js-sync-btn")) btn.addEventListener("click", syncNow);

  initSidebarResize();

  // Sidebar smart filters.
  for (const btn of $$(".source[data-filter]")) {
    btn.addEventListener("click", () => selectFilter(btn.dataset.filter));
  }

  // Settings pane: opened from the sidebar or ⌘, ; closed via the back button.
  $("#open-settings").addEventListener("click", () => showSettings(true));
  $("#settings-back").addEventListener("click", () => showSettings(false));

  // Notification actions: left-click an (openable) row to open it in the browser,
  // right-click for the row menu, ••• for the visible set. Enter opens a focused row.
  $("#inbox").addEventListener("click", onInboxClick);
  $("#inbox").addEventListener("keydown", onInboxKeydown);
  $("#inbox").addEventListener("contextmenu", onInboxContextMenu);
  $("#mark-all-done-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    // Toggle: a second click on the trigger closes the open confirm popover.
    if (openMenu) {
      closeMenu();
      return;
    }
    const btn = e.currentTarget;
    confirmDone(visibleNotifications().map((n) => n.thread_id), btn);
    // Reflect the expanded state for assistive tech (closeMenu resets it). Only when the
    // popover actually opened (confirmDone no-ops on an empty set).
    if (openMenu) btn.setAttribute("aria-expanded", "true");
  });
  // Dismiss the popover on any outside click or scroll. Ignore the trigger itself — its own
  // click handler toggles the popover, and closing here first (mousedown precedes click)
  // would let the click immediately reopen it, making it impossible to close.
  document.addEventListener("mousedown", (e) => {
    const onTrigger = e.target.closest?.("#mark-all-done-btn");
    if (openMenu && !openMenu.contains(e.target) && !onTrigger) closeMenu();
  });
  window.addEventListener("blur", closeMenu);
  $("#inbox").addEventListener("scroll", closeMenu, true);
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

