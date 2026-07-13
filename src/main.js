import { invoke } from "./js/api.js";
import { loadStorage } from "./js/storage.js";
import { initUpdates } from "./js/updates.js";
import { initSidebarResize } from "./js/sidebar-resize.js";
import { loadAccount, configureAccount } from "./js/account.js";
import { session } from "./js/state.js";
import {
  loadSyncStatus,
  syncNow,
  startPolling,
  stopPolling,
  registerSyncEvents,
} from "./js/sync.js";
import { initSettings, loadSettings, showSettings } from "./js/settings.js";
import "./js/inbox.js";
import { startDependabotMergePolling, stopDependabotMergePolling } from "./js/dependabot.js";
import {
  initModules,
  configureModules,
  activateCurrentModule,
  restoreLastModule,
} from "./js/modules.js";
import { initShortcuts } from "./js/shortcuts.js";
import { initBrandFlip } from "./js/brand-flip.js";

// Note: inbox.js and dependabot.js self-register with the module system (registerModule)
// at import time, including their lifecycle, sidebar selector, and shortcut groups. The
// named imports above trigger those registrations, so initModules() can wire them without
// separate side-effect imports.

/* main.js is the thin orchestrator: it wires each domain module's init on DOMContentLoaded
 * and connects the cross-domain lifecycle hooks. Modules self-register lifecycle +
 * shortcuts + sidebar contribution via `registerModule` — see inbox.js/dependabot.js.
 * Everything else lives in `js/`:
 *  - state.js     cross-module poll/session state
 *  - sync.js      notifications status header, sync flow, poll countdown
 *  - settings.js  Settings pane (appearance/theme + poll-interval form)
 *  - list-kit.js  shared list-view controller helpers (hover, kbd nav, focus)
 *  - account.js / storage.js / updates.js / sidebar-resize.js / menu.js  leaf domains
 *  - api.js / dom.js / format.js / *-model.js / *-view.js  pure helpers */

/* --------------------------------- Init ---------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  // Tag the platform so macOS-only chrome (e.g. the traffic-light toolbar inset) is scoped
  // to macOS and doesn't apply on Windows/Linux (the app bundles for all targets).
  if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.dataset.platform = "macos";
  }
  // Settings pane: theme picker, poll-interval form, pane open/close, and ⌘, all wired here.
  initSettings();

  for (const btn of document.querySelectorAll(".js-sync-btn")) {
    btn.addEventListener("click", syncNow);
  }

  initSidebarResize();
  initShortcuts();
  initBrandFlip();

  // Module system: render the title-bar module picker, wire ⌘1/⌘2, then call each
  // registered module's init() and load(). Modules register themselves via side-effect
  // imports above, so their lifecycle callbacks are available when initModules() runs.
  // The onBeforeSwitch hook dismisses the Settings overlay on any module switch (Settings
  // is NOT a module, so this lives in the app shell, not in any module's lifecycle).
  configureModules({
    onBeforeSwitch: () => showSettings(false),
  });
  initModules();

  registerSyncEvents();
  // Wire account auth transitions to the poll/sync lifecycle. account.js doesn't import the
  // sync machinery directly (avoids a circular dependency); it fires these hooks instead.
  configureAccount({
    onAuthenticated: (justSignedIn) => {
      // Signed in → begin the automatic poll loop (idempotent; restarts the countdown).
      startPolling();
      startDependabotMergePolling();
      if (justSignedIn) {
        // Fresh sign-in: refresh the cached login display + sync status with the new creds.
        loadSettings();
        loadSyncStatus();
      }
      // If auth resolved while a module was already active (e.g. restored into Dependabot
      // before auth completed), re-activate so its auth-gated logic (staleness-gated sync,
      // etc.) can run now.
      activateCurrentModule();
    },
    onSignedOut: () => {
      // A new session must re-prove a successful sync before the status pill goes green
      // again, so a stale persisted "success" doesn't show as green after re-signing in.
      session.syncedThisSession = false;
      // Signed out → stop polling so we never hit the API without a token.
      stopPolling();
      stopDependabotMergePolling();
    },
  });
  loadStorage();
  loadSyncStatus();
  loadSettings();
  initUpdates();
  // Let modules run once account bootstrap settles (signed in or signed out), so
  // auth-gated module activation can refresh from a stable auth state.
  loadAccount().finally(() => activateCurrentModule());

  // The window starts hidden (see tauri.conf.json) to avoid a flash on launch;
  // reveal it from Rust now that the DOM is built and styled. First restore the last opened
  // module so we reveal on the right pane rather than flashing the default one — but cap the
  // wait so a slow/hung persisted read can never keep the window hidden. We do not wait on
  // requestAnimationFrame: a hidden macOS WKWebView never paints, so its rAF
  // callbacks would never fire and the window would stay hidden forever. The Rust
  // safety-net (see lib.rs) reveals the window if this call ever fails.
  Promise.race([restoreLastModule(), new Promise((resolve) => setTimeout(resolve, 500))]).finally(
    () => {
      invoke("show_main_window").catch(() => {});
    },
  );
});
