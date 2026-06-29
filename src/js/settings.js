import { invoke } from "./api.js";
import { FALLBACK_MIN_POLL_INTERVAL_S, SETTINGS_DEBOUNCE_MS } from "./constants.js";
import { $, $$, flash } from "./dom.js";
import { poll } from "./state.js";
import { startPolling, updateSyncButtonHint } from "./sync.js";
import { isAuthenticated } from "./account.js";
import { isShortcutsOpen } from "./shortcuts.js";

/* The Settings pane: appearance/theme, the polling-interval form, and the pane toggle.
 * Theme and the settings form are persisted independently (toggling theme always saves,
 * even if the poll-interval field is mid-edit) but share the one inline error/flash row. */

/* --------------------------------- Theme --------------------------------- */

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

// In "system" mode, follow live OS appearance changes.
function onColorSchemeChange() {
  if (themePref === "system") {
    document.documentElement.dataset.theme = resolveTheme("system");
  }
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

/* ------------------------------ Settings form ----------------------------- */

/** Debounce timer for the polling-interval stepper (typed values settle before save). */
let settingsDebounce;

/** Monotonic token so only the latest save_settings response updates the UI (rapid
 * toggles/edits can otherwise let a slow, stale response overwrite newer state). */
let settingsApplySeq = 0;

/** Apply the poll-interval floor to local state, the input's `min`, and the note text.
 *  Used at init with the fallback, then by `loadSettings()` with the backend's value.
 *  Guards against a missing/non-numeric value so the clamp can never become NaN. */
function applyPollMin(seconds) {
  poll.minIntervalS = Number.isInteger(seconds)
    ? seconds
    : FALLBACK_MIN_POLL_INTERVAL_S;
  const input = $("#poll-interval");
  if (input) input.min = String(poll.minIntervalS);
  const label = $("#poll-min-label");
  if (label) label.textContent = String(poll.minIntervalS);
}

/** Show/hide the note explaining that GitHub's requested cadence is raising the user's
 *  interval, so the setting doesn't look silently ignored. Reads the latest floor captured
 *  from sync status (`poll.githubFloorS`); safe to call whenever the pane is shown. */
function updateSyncingNote() {
  const el = $("#poll-github-note");
  if (!el) return;
  const userInterval = Math.max(poll.intervalSeconds, poll.minIntervalS);
  if (poll.githubFloorS > userInterval) {
    el.textContent = ` GitHub is currently asking for at least ${poll.githubFloorS}s between polls, so that's the effective interval.`;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

export async function loadSettings() {
  try {
    const s = await invoke("get_settings");
    // The backend owns the floor; mirror it onto the input + local validation.
    applyPollMin(s.min_poll_interval_s);
    $("#poll-interval").value = s.poll_interval_s;
    poll.intervalSeconds = s.poll_interval_s;
    updateSyncingNote();
    updateSyncButtonHint();
    const themeInput = $(`input[name="theme"][value="${s.theme}"]`);
    if (themeInput) themeInput.checked = true;
    paintThemePref(s.theme);
    mirrorThemePref(s.theme);
    clearSettingsError();
  } catch (err) {
    setSettingsError(String(err));
  }
  await loadStartAtLogin();
}

/** Reflect the OS-level launch-at-login registration in the toggle. Errors leave it
 *  unchecked (the registration is the source of truth). */
async function loadStartAtLogin() {
  const el = $("#start-at-login");
  if (!el) return;
  try {
    el.checked = await invoke("get_start_at_login");
  } catch (err) {
    el.checked = false;
    console.error(`failed to read start-at-login: ${String(err)}`);
  }
}

/** Persist the toggle; disabled in-flight so quick on/off can't race, and re-reads the
 *  OS truth afterwards so the checkbox always reflects the real registration. */
async function persistStartAtLogin(enabled) {
  const el = $("#start-at-login");
  if (!el) return;
  el.disabled = true;
  try {
    await invoke("set_start_at_login", { enabled });
    flash($("#startup-flash"), "Saved");
  } catch (err) {
    flash($("#startup-flash"), String(err), "error");
  } finally {
    el.disabled = false;
    await loadStartAtLogin();
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
  if (!Number.isInteger(pollIntervalS) || pollIntervalS < poll.minIntervalS) {
    setSettingsError(`Min ${poll.minIntervalS}s`);
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
    if (s.poll_interval_s !== poll.intervalSeconds) {
      poll.intervalSeconds = s.poll_interval_s;
      if (isAuthenticated()) startPolling();
    }
    // The user's interval may now be below/above GitHub's floor — refresh the note + tooltip.
    updateSyncingNote();
    updateSyncButtonHint();
  } catch (err) {
    if (seq !== settingsApplySeq) return;
    setSettingsError(String(err));
  }
}

/* --------------------------------- Panes --------------------------------- */

/** Toggle between the notifications pane and the Settings pane (single window). */
export function showSettings(show) {
  // Detect an actual pane transition: selectFilter/selectRepo call showSettings(false)
  // while already in Notifications, and we must not steal focus in that case.
  const wasShown = !$("#view-settings").hidden;
  $("#view-notifications").hidden = show;
  $("#view-settings").hidden = !show;
  // Settings is a focused, full-width pane: hide the sidebar (and its resizer) so the
  // content spans the whole window. CSS also insets the toolbar past the traffic lights.
  document.querySelector(".app")?.classList.toggle("app--settings", show);
  if (show) {
    // Refresh the GitHub-cadence note with the latest floor learned from sync status.
    updateSyncingNote();
  }
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

/* ---------------------------------- Init --------------------------------- */

/** Wire all Settings-pane DOM listeners (theme picker, poll-interval form, pane toggles).
 *  Call once on DOMContentLoaded. `loadSettings()` then hydrates the controls from SQLite. */
export function initSettings() {
  // In "system" mode, follow live OS appearance changes. `addEventListener` on a
  // MediaQueryList is unavailable on the oldest supported WebKit (macOS 10.15 / Safari
  // 13), so fall back to the deprecated `addListener`.
  if (darkMql.addEventListener) {
    darkMql.addEventListener("change", onColorSchemeChange);
  } else if (darkMql.addListener) {
    darkMql.addListener(onColorSchemeChange);
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

  // Launch-at-login: persist immediately on toggle (the OS registration is the source of
  // truth, so loadSettings re-reads it on load).
  $("#start-at-login")?.addEventListener("change", (e) => {
    persistStartAtLogin(e.target.checked);
  });

  // Settings pane: opened from the sidebar or via the ⌘, shortcut; closed via the back
  // button (and toggled by ⌘, again).
  $("#open-settings").addEventListener("click", () => showSettings(true));
  $("#settings-back").addEventListener("click", () => showSettings(false));
  document.addEventListener("keydown", (e) => {
    // Don't toggle Settings behind the (modal) shortcuts overlay.
    if (isShortcutsOpen()) return;
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      showSettings($("#view-settings").hidden);
    }
  });
}
