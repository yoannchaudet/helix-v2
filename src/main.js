import { invoke } from "./js/api.js";
import { $$ } from "./js/dom.js";
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
  configureSync,
} from "./js/sync.js";
import { initSettings, loadSettings } from "./js/settings.js";
import { initInbox, loadInbox } from "./js/inbox.js";
import { initShortcuts } from "./js/shortcuts.js";

/* main.js is the thin orchestrator: it wires each domain module's init on DOMContentLoaded
 * and connects the cross-domain lifecycle hooks. Everything else lives in `js/`:
 *  - state.js     cross-module poll/session state
 *  - sync.js      notifications status header, sync flow, poll countdown
 *  - settings.js  Settings pane (appearance/theme + poll-interval form)
 *  - inbox.js     notification list + sidebar, focus, mark-done, interactions
 *  - account.js / storage.js / updates.js / sidebar-resize.js / menu.js  leaf domains
 *  - api.js / dom.js / format.js / inbox-model.js / inbox-view.js  pure helpers */

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
  initInbox();
  initShortcuts();

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

