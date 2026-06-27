/* Pure date/time formatters. No DOM, no app state — safe to unit-test directly. */

/** Absolute, locale-formatted timestamp (e.g. for "Last synced"). `null`/empty → "never";
 *  an unparseable value is returned unchanged. */
export function fmtTimestamp(value) {
  if (!value) return "never";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/** Compact relative time (e.g. "just now", "5m ago", "3d ago"). Empty input → "";
 *  an unparseable value is returned unchanged. */
export function relTime(value) {
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
