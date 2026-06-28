import { DEFAULT_POLL_INTERVAL_S, FALLBACK_MIN_POLL_INTERVAL_S } from "./constants.js";

/* Small shared-state module for the handful of values that genuinely cross module
 * boundaries. Each export is a mutable object so importers see writes by reference;
 * state owned by a single module stays inside that module, not here. */

/** Automatic-poll configuration. Written by Settings (the saved cadence and the backend's
 *  floor), read by the sync poll loop. */
export const poll = {
  /** Configured polling cadence (seconds); kept in sync with the saved setting. */
  intervalSeconds: DEFAULT_POLL_INTERVAL_S,
  /** Floor for the poll interval. Authoritative value comes from the backend
   *  (`get_settings().min_poll_interval_s`); this is just a fallback until settings load. */
  minIntervalS: FALLBACK_MIN_POLL_INTERVAL_S,
  /** GitHub's requested poll-cadence floor (`X-Poll-Interval` / `Retry-After`), in seconds,
   *  from the last sync status; 0 when GitHub requested nothing. Honored on top of the
   *  user's interval and surfaced in the UI (refresh tooltip + Settings note). */
  githubFloorS: 0,
};

/** Per-session flags reset when the signed-in identity changes. */
export const session = {
  /** True once a sync has succeeded *in this session*. Until then the status pill stays
   *  neutral: at launch we only show cached local state and haven't confirmed Keychain or
   *  network access, so an affirmative green "Synced" would be misleading. */
  syncedThisSession: false,
};
