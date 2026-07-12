/* Pure inbox model logic: smart-filter predicates, cleanup-candidacy, and the
   filter → repo-refine → sort pipeline. No DOM and no shared mutable state — every
   function takes its inputs as arguments and returns new data, so this is the testable
   "core" the views render from. */

// Re-export generic list utilities so existing imports keep working. The canonical home
// is list-kit-model.js; inbox-model.js re-exports for backward compatibility.
export { sortReposByRecency, latestUpdatedAt } from "./list-kit-model.js";

// Local import for use within this module (re-exports don't bind locally).
import { sortReposByRecency } from "./list-kit-model.js";

/** Cleanup candidates: notifications safe to mark as done (design.md §6). A merged or
 *  closed pull request, or a closed issue. Subjects that aren't yet resolved (no
 *  `subject_state`) and other subject types are excluded. The resolved state is only
 *  trusted when it reflects the latest thread activity (`updated_at <= resolved_at`,
 *  mirroring the backend's staleness rule) — so a subject that changed since we last
 *  resolved it (e.g. a reopened issue) is excluded until re-resolution catches up, and we
 *  never offer a stale candidate to clear. */
export function isCleanupCandidate(n) {
  if (!n.resolved_at || n.updated_at > n.resolved_at) return false;
  if (n.subject_type === "PullRequest") {
    return n.subject_state === "merged" || n.subject_state === "closed";
  }
  if (n.subject_type === "Issue") {
    return n.subject_state === "closed";
  }
  return false;
}

/** A notification that's been pulled but has no subject-state pill yet: a Pull Request or Issue
 *  with no `subject_state`. Background subject resolution fills this in shortly after a sync;
 *  other subject types (Discussion, Release, …) never get a state pill, so they're never
 *  "awaiting". Keyed on the *absence* of a state (not `resolved_at` freshness) so a row that
 *  already shows a pill is never re-striped — this is purely the "state unknown / still loading"
 *  cue. Drives a subtle striped-row background. */
export function isAwaitingState(n) {
  return (n.subject_type === "PullRequest" || n.subject_type === "Issue") && !n.subject_state;
}

/** Smart filters: predicate over a notification + the human label for the toolbar. */
export const FILTERS = {
  all: { label: "All", match: () => true },
  mention: { label: "Mentions", match: (n) => n.reason === "mention" },
  team_mention: {
    label: "Team mentions",
    match: (n) => n.reason === "team_mention",
  },
  review_requested: {
    label: "Review requests",
    match: (n) => n.reason === "review_requested",
  },
  assign: { label: "Assigned", match: (n) => n.reason === "assign" },
  cleanup: { label: "Cleanup", match: (n) => isCleanupCandidate(n) },
  bookmarked: { label: "Bookmarks", match: (n) => n.bookmarked },
};

/** Subject-type buckets for the top-of-view type filter (orthogonal to the smart filters
 *  and the per-repo refinement). Pull requests and issues are the two common subjects;
 *  everything else (Discussion, Release, Commit, CheckSuite, …) folds into "other". */
export function subjectTypeBucket(n) {
  if (n.subject_type === "PullRequest") return "pr";
  if (n.subject_type === "Issue") return "issue";
  return "other";
}

/** Ordered type-filter definitions; the single source of truth for the pill ids + labels. */
export const TYPE_FILTERS = [
  { id: "pr", label: "Pull requests" },
  { id: "issue", label: "Issues" },
  { id: "other", label: "Other" },
];

/** Does a notification's subject type fall within the selected set of buckets? */
export function typeMatch(n, selectedTypes) {
  return selectedTypes.has(subjectTypeBucket(n));
}

/** Narrow each group's notifications to the selected type buckets, dropping groups left
 *  empty. Returns new group objects; the input is not mutated. Mirrors `filterGroups`'
 *  shape so it can pre-filter the dataset before the smart-filter/repo pipeline runs. */
export function filterGroupsByType(groups, selectedTypes) {
  return groups
    .map((g) => ({
      ...g,
      notifications: g.notifications.filter((n) => typeMatch(n, selectedTypes)),
    }))
    .filter((g) => g.notifications.length);
}

/** Per-filter subtitle for the (illustrated) empty state. The title is always the same
 *  small "you're caught up" win; the subtitle says specifically what's empty. */
export const EMPTY_SUBTITLES = {
  all: "No notifications right now.",
  mention: "No mentions right now.",
  team_mention: "No team mentions right now.",
  review_requested: "No review requests right now.",
  assign: "Nothing's assigned to you right now.",
  cleanup: "No stale subscriptions to clean.",
  bookmarked: "No bookmarks yet.",
};

/** Notifications in `group` matching the given type filter. */
export function repoMatches(group, filterId) {
  const match = (FILTERS[filterId] ?? FILTERS.all).match;
  return group.notifications.filter(match);
}

/** Apply the active filter, then the optional repo refinement, to `groups`, ordering the
 *  repos most-recent-first. Returns new group objects (notifications narrowed to matches);
 *  the input is not mutated. */
export function filterGroups(groups, filterId, repoId) {
  let result = groups
    .map((g) => ({ ...g, notifications: repoMatches(g, filterId) }))
    .filter((g) => g.notifications.length);
  if (repoId != null) {
    result = result.filter((g) => g.repo_id === repoId);
  }
  // Bubble the repo with the most recently updated matching notification to the top.
  return sortReposByRecency(
    result,
    (g) => g.notifications,
    (g) => g.full_name,
  );
}
