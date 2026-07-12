import { invoke } from "./js/api.js";
import { $$, clearAnnounceQueue } from "./js/dom.js";
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
import { initSettings, loadSettings, showSettings } from "./js/settings.js";
import { initInbox, loadInbox } from "./js/inbox.js";
import {
  initDependabot,
  onDependabotOpened,
  startDependabotMergePolling,
  stopDependabotMergePolling,
} from "./js/dependabot.js";
import { initModules, configureModules, restoreLastModule, getActiveModule } from "./js/modules.js";
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
  initDependabot();
  initShortcuts();

  // Module system: render the title-bar module picker and wire ⌘1/⌘2. Switching modules
  // dismisses the Settings overlay, and opening the Dependabot module loads it (and
  // staleness-gated auto-syncs). modules.js fires onSwitch rather than importing these
  // modules, keeping the dependency one-directional.
  initModules();
  configureModules({
    onSwitch: (id) => {
      showSettings(false);
      if (id === "dependabot") onDependabotOpened();
      else clearAnnounceQueue();
    },
  });

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
      startDependabotMergePolling();
      if (justSignedIn) {
        // Fresh sign-in: refresh the cached login display + sync status with the new creds.
        loadSettings();
        loadSyncStatus();
      }
      // If we restored into Dependabot before auth resolved, its auth-gated auto-sync was
      // skipped; now that we're authenticated, run its open behavior (staleness-gated, so
      // it's a no-op when data is fresh).
      if (getActiveModule() === "dependabot") onDependabotOpened();
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
  // Load the account first so the inbox knows whether to show its signed-out hint.
  loadAccount().finally(loadInbox);

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
