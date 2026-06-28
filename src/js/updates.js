/* Auto-update flow (release macOS builds): the Settings → Updates controls and the
   prompt banner shown atop the notifications pane. The backend (lib.rs) owns the actual
   check/download/install and relaunch; this module is the UI around it.

   `initUpdates()` is the only entry point; everything else is internal. */

import { invoke, listen } from "./api.js";
import { $, flash, toast } from "./dom.js";

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
export async function initUpdates() {
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
