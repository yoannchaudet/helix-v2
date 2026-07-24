/* Pure snooze logic: the fixed set of snooze durations and how a deadline is worded. No DOM
   and no app state, so this is directly unit-testable.

   Deadlines are computed in the user's **local** time and stored as UTC `...Z` strings: the
   backend compares them lexically against SQLite's UTC clock, and lexical order matches
   chronological order for that canonical format. */

/** UTC `...Z` seconds-precision string, matching what the backend writes. */
function toUtc(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** `date` shifted by whole minutes of *elapsed* time. Deliberately epoch arithmetic, not
 *  `setMinutes()`: "in 3 hours" must mean three real hours even across a DST transition,
 *  which local calendar arithmetic would stretch to four (or shrink to two). */
function plusMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

/** The hour snoozes that roll over to a day boundary wake at (local time). */
export const MORNING_HOUR = 9;

/** `date` moved to `MORNING_HOUR:00` local time on the day `days` later. Uses calendar
 *  arithmetic (not a fixed +24h offset) so a DST transition doesn't shift the wake time. */
function morningAfter(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  d.setHours(MORNING_HOUR, 0, 0, 0);
  return d;
}

/** The offered snooze durations, in menu order. Deliberately a fixed set (no custom picker):
 *  each `resolve(now)` returns the local `Date` the notification comes back. `label` is the
 *  menu wording; `shortLabel` is the compact form used by the keyboard hint, where an
 *  option's 1-based position is also its shortcut digit. */
export const SNOOZE_OPTIONS = [
  {
    id: "20m",
    label: "In 20 minutes",
    shortLabel: "20 min",
    resolve: (now) => plusMinutes(now, 20),
  },
  { id: "1h", label: "In 1 hour", shortLabel: "1 hour", resolve: (now) => plusMinutes(now, 60) },
  { id: "3h", label: "In 3 hours", shortLabel: "3 hours", resolve: (now) => plusMinutes(now, 180) },
  {
    id: "tomorrow",
    label: "Tomorrow",
    shortLabel: "tomorrow",
    resolve: (now) => morningAfter(now, 1),
  },
  {
    id: "next_week",
    label: "Next week",
    shortLabel: "next week",
    // The next Monday morning — never today, so a Monday snooze lands a full week out.
    resolve: (now) => morningAfter(now, (8 - now.getDay()) % 7 || 7),
  },
];

/** One-line prompt listing each duration behind its shortcut digit, shown while the `s`
 *  snooze chord is armed. */
export const SNOOZE_HINT = `Snooze until… ${SNOOZE_OPTIONS.map(
  (o, i) => `${i + 1} ${o.shortLabel}`,
).join("  ·  ")}`;

/** Resolve a snooze option id to the UTC deadline to persist. Returns null for an unknown id
 *  so callers can no-op rather than write a bad timestamp. */
export function snoozeUntil(optionId, now = new Date()) {
  const option = SNOOZE_OPTIONS.find((o) => o.id === optionId);
  return option ? toUtc(option.resolve(now)) : null;
}

/** How a pending snooze reads on a row: "in 18m" / "in 3h" / "tomorrow 9:00 AM" /
 *  "Mon 9:00 AM" / "Jan 20, 9:00 AM". Anything under a minute out (or already past) reads
 *  "any moment now", since the row is about to come back on its own. Unparseable input is
 *  returned unchanged, mirroring `relTime`. */
export function fmtSnoozeUntil(untilAt, now = new Date()) {
  if (!untilAt) return "";
  const then = new Date(untilAt);
  if (Number.isNaN(then.getTime())) return untilAt;
  const minutes = Math.round((then.getTime() - now.getTime()) / 60000);
  if (minutes < 1) return "any moment now";
  if (minutes < 60) return `in ${minutes}m`;
  const time = then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Same calendar day: an hour offset is the clearest reading.
  if (then.toDateString() === now.toDateString()) {
    return minutes < 24 * 60 ? `in ${Math.round(minutes / 60)}h` : time;
  }
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (then.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  // Within the coming week, the weekday is more useful than a date.
  if (minutes < 7 * 24 * 60) {
    return `${then.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${then.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
