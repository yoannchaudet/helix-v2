/* Pure model logic for the SLO Dips browse view: shaping the flat list of dips the backend
 * returns (`slo_dips::SloDip`, already ordered dip_date DESC) into per-repository groups the
 * view renders, plus small presentation helpers. No DOM, no shared mutable state — every
 * function takes its inputs and returns new data, so this is the testable core. */

/** Whether a dip has been investigated (a non-bot user replied to the bot's dip comment). */
export function dipStatus(dip) {
  return dip.investigated ? "investigated" : "pending";
}

/** Format a raw percentage number for display, trimming floating-point noise to at most three
 *  decimals (the precision the SLO bot posts). e.g. `99.967` → `"99.967%"`, `99.99` → `"99.99%"`. */
export function formatPercent(percent) {
  if (typeof percent !== "number" || Number.isNaN(percent)) return "—";
  return `${+percent.toFixed(3)}%`;
}

/** Aggregate counts across a list of dips. */
export function summarize(dips) {
  let investigated = 0;
  for (const dip of dips) if (dip.investigated) investigated += 1;
  return { total: dips.length, investigated, pending: dips.length - investigated };
}

/** Per-repository dip tallies keyed by `repo_id`, each `{ total, investigated }`. Drives the
 *  sidebar's "investigated / total" count badges. Repos with no dips are simply absent. */
export function countDipsByRepoId(dips) {
  const counts = new Map();
  for (const dip of dips) {
    const tally = counts.get(dip.repo_id) ?? { total: 0, investigated: 0 };
    tally.total += 1;
    if (dip.investigated) tally.investigated += 1;
    counts.set(dip.repo_id, tally);
  }
  return counts;
}

/** A DOM-safe, collision-free id fragment for a repository `full_name` (which contains `/`),
 *  used to tie a repo section to its heading via `aria-labelledby`. `encodeURIComponent`
 *  keeps the encoding injective so distinct repo names can never share an id. */
export function repoDomId(fullName) {
  return `slo-repo-${encodeURIComponent(String(fullName))}`;
}

/** Group dips by repository, preserving the backend's dip_date-descending order within each
 *  group. Repositories are ordered by their most recent dip (newest first), then by name.
 *  Returns new objects; the input is not mutated. */
export function groupDipsByRepo(dips) {
  const groups = new Map();
  for (const dip of dips) {
    const key = dip.repo_full_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(dip);
  }
  return [...groups.entries()]
    .map(([repoFullName, repoDips]) => ({
      repoFullName,
      dips: repoDips,
      ...summarize(repoDips),
      latestDipDate: repoDips.reduce((max, d) => (d.dip_date > max ? d.dip_date : max), ""),
    }))
    .sort(
      (a, b) =>
        b.latestDipDate.localeCompare(a.latestDipDate) ||
        a.repoFullName.localeCompare(b.repoFullName),
    );
}
