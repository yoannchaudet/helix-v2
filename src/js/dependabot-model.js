/* Pure model logic for the Dependabot module: the repo-refine → sort pipeline over the
 * by-repo PR groups the backend returns. No DOM, no shared mutable state — every function
 * takes its inputs and returns new data, so this is the testable core the view renders from.
 *
 * A Dependabot group is `{ full_name, total, prs: [...] }` (see `dependabot::DependabotRepoGroup`
 * in Rust); repositories are refined by `full_name` (Dependabot has no notification-style
 * repo ids). Recency sorting reuses the generic helper shared with the inbox model. */

import { sortReposByRecency } from "./inbox-model.js";

/** Apply the optional repository refinement (by `full_name`), then order repos
 *  most-recently-updated first. Returns new group objects; the input is not mutated. */
export function filterDependabotGroups(groups, repoName) {
  let result = groups;
  if (repoName != null) {
    result = result.filter((g) => g.full_name === repoName);
  }
  return sortReposByRecency(
    result,
    (g) => g.prs,
    (g) => g.full_name,
  );
}

/** Total number of PRs across all groups. */
export function totalPrs(groups) {
  return groups.reduce((n, g) => n + g.prs.length, 0);
}

/** A DOM-safe id fragment for a repository `full_name` (which contains `/`), used to tie a
 *  repo section to its heading via `aria-labelledby`. */
export function repoDomId(fullName) {
  return `dep-repo-${fullName.replace(/[^a-zA-Z0-9]+/g, "-")}`;
}
