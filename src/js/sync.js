import { invoke, listen } from "./api.js";
import { POLL_TICK_MS, SYNC_PROGRESS_DISMISS_MS, STATES } from "./constants.js";
import { $, $$, escapeHtml } from "./dom.js";
import { relTime, fmtTimestamp } from "./format.js";
import { poll, session } from "./state.js";
import { isAuthenticated, loadAccount } from "./account.js";

/* The sync domain: the "Notifications" status header (status pill, rate-limit bars,
 * progress message), the manual/automatic sync flow, and the poll countdown. */

/** True while a sync is in flight; gates stale sync:progress events. */
let syncing = false;
/** Timer that clears the transient post-sync "Stored N" progress message. */
let syncProgressTimer;
/** 1-second tick driving the automatic poll + the refresh-button clock sweep. */
let pollTimer = null;
/** Seconds elapsed since the last sync; reset to 0 after every sync. */
let pollElapsed = 0;

/** Called when a sync (or background subject resolution) makes the inbox stale; wired by
 *  main.js to reload the inbox. Kept as a hook so the inbox view can stay in main.js
 *  without sync importing it (which would create a cycle). */
let onInboxStale = null;

export function configureSync({ onInboxStale: inboxStale } = {}) {
  onInboxStale = inboxStale ?? null;
}

/* ------------------------------ Rate limits ------------------------------- */

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

/* ------------------------------ Status header ----------------------------- */

function renderSyncStats(status) {
  const lastEl = $("#last-synced");
  if (lastEl) lastEl.textContent = fmtTimestamp(status.last_sync_at);
  renderRateBuckets(status.rate_buckets || []);
  // Adopt GitHub's requested poll floor so the next automatic poll honors its cadence, and
  // reflect it in the refresh button's tooltip when it's actually raising the user's interval.
  poll.githubFloorS = Number(status.github_poll_interval_s) || 0;
  updateSyncButtonHint();

  if (status.last_status === "error" && status.last_error) {
    setSyncStatus("error", "Error");
    setSyncProgress(status.last_error, "error");
  } else if (status.last_status === "success") {
    // Green only confirms a sync that happened in this session. On launch we're showing
    // cached local state, so the same "success" record renders neutral with its age.
    const label = status.last_sync_at
      ? `Synced ${relTime(status.last_sync_at)}`
      : "Synced";
    setSyncStatus(session.syncedThisSession ? "success" : "neutral", label);
  } else {
    setSyncStatus("pending", "Never synced");
  }
}

/** Update the refresh button's tooltip to explain when GitHub's requested cadence is
 *  raising the user's poll interval (the common source of "why isn't my interval honored?").
 *  Leaves the accessible name as the plain action; the Settings note carries this for AT.
 *  Exported so Settings can also refresh it when the user changes their interval. */
export function updateSyncButtonHint() {
  const btn = $("#sync-btn");
  if (!btn) return;
  const userInterval = Math.max(poll.intervalSeconds, poll.minIntervalS);
  btn.title =
    poll.githubFloorS > userInterval
      ? `Sync now — GitHub asks for ≥${poll.githubFloorS}s between polls, raising your ${userInterval}s`
      : "Sync now";
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

/** Set the inline sync-progress message, cancelling any pending auto-clear so a persistent
 *  message (e.g. an error) can't be wiped out from under the user. */
export function setSyncProgress(text, kind = "") {
  clearTimeout(syncProgressTimer);
  for (const el of $$(".js-sync-progress")) {
    el.className = `form-msg js-sync-progress${kind ? ` form-msg--${kind}` : ""}`;
    el.textContent = text;
  }
}

/** Show a transient message that clears itself shortly after, used for success
 *  confirmations whose durable record lives elsewhere (e.g. the "Last synced" row). */
export function flashSyncProgress(text, kind = "") {
  setSyncProgress(text, kind);
  syncProgressTimer = setTimeout(() => setSyncProgress(""), SYNC_PROGRESS_DISMISS_MS);
}

function setSyncBusy(busy) {
  for (const btn of $$(".js-sync-btn")) btn.disabled = busy;
  // The toolbar button turns the accent color while a sync is in flight (due state).
  $("#sync-btn")?.classList.toggle("is-due", busy);
}

export async function loadSyncStatus() {
  setSyncStatus("pending", "Loading…");
  try {
    const status = await invoke("sync_status");
    renderSyncStats(status);
  } catch (err) {
    setSyncStatus("error", "Error");
    setSyncProgress(String(err), "error");
  }
}

export async function syncNow() {
  setSyncBusy(true);
  syncing = true;
  setSyncStatus("pending", "Syncing…");
  setSyncProgress("Starting…");

  try {
    const result = await invoke("sync_now");
    // Stop accepting progress updates before writing the final message, so a
    // late-delivered sync:progress event can't overwrite it.
    syncing = false;
    session.syncedThisSession = true;
    const removed = result.removed ?? 0;
    const storedMsg = `Stored ${result.count} notification${result.count === 1 ? "" : "s"}`;
    // Transient: the durable record is the "Last synced" row, so the inline "Stored N"
    // message clears itself shortly after it appears.
    flashSyncProgress(
      removed > 0 ? `${storedMsg}, removed ${removed}.` : `${storedMsg}.`,
      "success",
    );
    await loadSyncStatus();
    await onInboxStale?.();
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
  if (!isAuthenticated() || syncing) return;
  pollElapsed += 1;
  // Honor GitHub's requested cadence (X-Poll-Interval / Retry-After) on top of the user's
  // interval and the app's hard minimum.
  const interval = Math.max(poll.intervalSeconds, poll.minIntervalS, poll.githubFloorS);
  setPollProgress(Math.min(pollElapsed / interval, 1));
  if (pollElapsed >= interval) syncNow();
}

/** Begin (or restart) the automatic poll loop. Safe to call repeatedly. */
export function startPolling() {
  stopPolling();
  resetPollCountdown();
  pollTimer = setInterval(pollTick, POLL_TICK_MS);
}

export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  resetPollCountdown();
}

/** Live progress from the backend during a sync. */
export function registerSyncEvents() {
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
    onInboxStale?.();
    loadSyncStatus();
  });
}
