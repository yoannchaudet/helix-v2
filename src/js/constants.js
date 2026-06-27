/* Named knobs gathered here so behavior isn't tuned via scattered magic numbers.
   The poll-interval floor is NOT here on purpose — it's owned by the Rust backend
   (`get_settings().min_poll_interval_s`) so the UI can't drift from it. */

/** Automatic-poll heartbeat: how often `pollTick` runs (ms). */
export const POLL_TICK_MS = 1000;
/** Polling cadence (s) assumed until the saved setting loads. */
export const DEFAULT_POLL_INTERVAL_S = 60;
/** Fallback poll-interval floor used only until/if `loadSettings()` provides the
 *  authoritative `min_poll_interval_s` from the backend. Mirrors the Rust default. */
export const FALLBACK_MIN_POLL_INTERVAL_S = 10;

/** Auto-dismiss timings (ms) for transient feedback. */
export const FLASH_DISMISS_MS = 1800;
export const TOAST_DISMISS_MS = 1600;
export const SYNC_PROGRESS_DISMISS_MS = 2600;

/** Sidebar resize bounds (px). The minimum falls back to the CSS `--sidebar-w`. */
export const SIDEBAR_MIN_FALLBACK_PX = 232;
export const SIDEBAR_MAX_PX = 520;
export const SIDEBAR_KEY_STEP_PX = 16;

/** Debounce (ms) before persisting a typed polling-interval value. */
export const SETTINGS_DEBOUNCE_MS = 450;

/** The color-coded sync states (status dot/label modifier suffixes). */
export const STATES = ["pending", "success", "error", "neutral"];
