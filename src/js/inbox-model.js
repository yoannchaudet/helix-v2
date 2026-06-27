/* Pure inbox model logic: smart-filter predicates, cleanup-candidacy, and the
   filter → repo-refine → sort pipeline. No DOM and no shared mutable state — every
   function takes its inputs as arguments and returns new data, so this is the testable
   "core" the views render from. */

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
};

/** Per-filter subtitle for the (illustrated) empty state. The title is always the same
 *  small "you're caught up" win; the subtitle says specifically what's empty. */
export const EMPTY_SUBTITLES = {
  all: "No notifications right now.",
  mention: "No mentions right now.",
  team_mention: "No team mentions right now.",
  review_requested: "No review requests right now.",
  assign: "Nothing's assigned to you right now.",
  cleanup: "No stale subscriptions to clean.",
};

/** Notifications in `group` matching the given type filter. */
export function repoMatches(group, filterId) {
  const match = (FILTERS[filterId] ?? FILTERS.all).match;
  return group.notifications.filter(match);
}

/** Most recent `updated_at` in a notification list (ISO-8601 UTC strings compare lexically,
 *  so the newest is the max). Empty list → "". */
export function latestUpdatedAt(notifications) {
  let max = "";
  for (const n of notifications) {
    if (n.updated_at > max) max = n.updated_at;
  }
  return max;
}

/** Order repo-like items most-recent-first by their newest (matching) notification, with
 *  repo name as a deterministic tie-breaker. Recency is computed once per item (not on every
 *  comparison), and names compare by code point so the order is stable across locales. */
export function sortReposByRecency(items, getNotifications, getName) {
  return items
    .map((item) => ({
      item,
      recency: latestUpdatedAt(getNotifications(item)),
      name: getName(item),
    }))
    .sort((a, b) => {
      if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    })
    .map((x) => x.item);
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
  return sortReposByRecency(result, (g) => g.notifications, (g) => g.full_name);
}
