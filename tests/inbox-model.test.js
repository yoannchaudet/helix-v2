import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS,
  EMPTY_SUBTITLES,
  isCleanupCandidate,
  repoMatches,
  latestUpdatedAt,
  sortReposByRecency,
  filterGroups,
} from "../src/js/inbox-model.js";

/* ------------------------------ isCleanupCandidate ------------------------------ */
// The fragile rule (design.md §6): only merged/closed PRs and closed issues that are
// RESOLVED and whose resolved state still reflects the latest activity (updated <= resolved).

test("isCleanupCandidate: merged/closed PRs and closed issues are candidates", () => {
  const resolved = "2020-02-01T00:00:00Z";
  const older = "2020-01-01T00:00:00Z";
  assert.equal(
    isCleanupCandidate({ subject_type: "PullRequest", subject_state: "merged", resolved_at: resolved, updated_at: older }),
    true,
  );
  assert.equal(
    isCleanupCandidate({ subject_type: "PullRequest", subject_state: "closed", resolved_at: resolved, updated_at: older }),
    true,
  );
  assert.equal(
    isCleanupCandidate({ subject_type: "Issue", subject_state: "closed", resolved_at: resolved, updated_at: older }),
    true,
  );
});

test("isCleanupCandidate: open subjects and non-PR/Issue types are not candidates", () => {
  const resolved = "2020-02-01T00:00:00Z";
  const older = "2020-01-01T00:00:00Z";
  assert.equal(
    isCleanupCandidate({ subject_type: "PullRequest", subject_state: "open", resolved_at: resolved, updated_at: older }),
    false,
  );
  assert.equal(
    isCleanupCandidate({ subject_type: "Issue", subject_state: "open", resolved_at: resolved, updated_at: older }),
    false,
  );
  assert.equal(
    isCleanupCandidate({ subject_type: "Discussion", subject_state: "closed", resolved_at: resolved, updated_at: older }),
    false,
  );
});

test("isCleanupCandidate: unresolved subjects are excluded", () => {
  assert.equal(
    isCleanupCandidate({ subject_type: "Issue", subject_state: "closed", resolved_at: null, updated_at: "2020-01-01T00:00:00Z" }),
    false,
  );
});

test("isCleanupCandidate: stale resolved state (updated_at > resolved_at) is excluded", () => {
  // e.g. a closed issue that was reopened/commented since we last resolved its state.
  assert.equal(
    isCleanupCandidate({ subject_type: "Issue", subject_state: "closed", resolved_at: "2020-01-01T00:00:00Z", updated_at: "2020-02-01T00:00:00Z" }),
    false,
  );
});

test("isCleanupCandidate: updated_at == resolved_at is fresh (boundary, inclusive)", () => {
  const same = "2020-01-01T00:00:00Z";
  assert.equal(
    isCleanupCandidate({ subject_type: "PullRequest", subject_state: "merged", resolved_at: same, updated_at: same }),
    true,
  );
});

/* ----------------------------------- FILTERS ----------------------------------- */

test("FILTERS predicates match on reason; cleanup uses isCleanupCandidate", () => {
  assert.equal(FILTERS.all.match({}), true);
  assert.equal(FILTERS.mention.match({ reason: "mention" }), true);
  assert.equal(FILTERS.mention.match({ reason: "assign" }), false);
  assert.equal(FILTERS.team_mention.match({ reason: "team_mention" }), true);
  assert.equal(FILTERS.review_requested.match({ reason: "review_requested" }), true);
  assert.equal(FILTERS.assign.match({ reason: "assign" }), true);

  const cleanupOk = { subject_type: "Issue", subject_state: "closed", resolved_at: "2020-02-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" };
  assert.equal(FILTERS.cleanup.match(cleanupOk), true);
  assert.equal(FILTERS.cleanup.match({ reason: "mention" }), false);
});

test("every filter has a label and an empty-state subtitle", () => {
  for (const key of Object.keys(FILTERS)) {
    assert.equal(typeof FILTERS[key].label, "string");
    assert.equal(typeof EMPTY_SUBTITLES[key], "string");
  }
});

/* --------------------------------- repoMatches --------------------------------- */

test("repoMatches filters a group's notifications by the active filter", () => {
  const group = { notifications: [{ reason: "mention" }, { reason: "assign" }, { reason: "mention" }] };
  assert.equal(repoMatches(group, "mention").length, 2);
  assert.equal(repoMatches(group, "assign").length, 1);
  // Unknown filter id falls back to "all".
  assert.equal(repoMatches(group, "does-not-exist").length, 3);
});

/* ------------------------------- latestUpdatedAt ------------------------------- */

test("latestUpdatedAt returns the max ISO timestamp, or '' for empty", () => {
  assert.equal(
    latestUpdatedAt([{ updated_at: "2020-01-01T00:00:00Z" }, { updated_at: "2020-03-01T00:00:00Z" }, { updated_at: "2020-02-01T00:00:00Z" }]),
    "2020-03-01T00:00:00Z",
  );
  assert.equal(latestUpdatedAt([]), "");
});

/* ----------------------------- sortReposByRecency ----------------------------- */

test("sortReposByRecency orders most-recent-first with name as a stable tiebreak", () => {
  const items = [
    { full_name: "b/x", notifications: [{ updated_at: "2020-01-01T00:00:00Z" }] },
    { full_name: "a/x", notifications: [{ updated_at: "2020-03-01T00:00:00Z" }] },
    { full_name: "c/x", notifications: [{ updated_at: "2020-03-01T00:00:00Z" }] },
  ];
  const order = sortReposByRecency(items, (g) => g.notifications, (g) => g.full_name).map((g) => g.full_name);
  // a/x and c/x share the newest recency → ordered by name; b/x (older) last.
  assert.deepEqual(order, ["a/x", "c/x", "b/x"]);
});

test("sortReposByRecency name tiebreak compares by code point, not locale", () => {
  const items = [
    { full_name: "a/repo", notifications: [{ updated_at: "2020-01-01T00:00:00Z" }] },
    { full_name: "Z/repo", notifications: [{ updated_at: "2020-01-01T00:00:00Z" }] },
  ];
  const order = sortReposByRecency(items, (g) => g.notifications, (g) => g.full_name).map((g) => g.full_name);
  // Same recency → tiebreak via `<`: "Z" (U+005A) < "a" (U+0061). A locale-aware sort would
  // instead put "a" first, so this locks in the code-point ordering.
  assert.deepEqual(order, ["Z/repo", "a/repo"]);
});

test("sortReposByRecency does not mutate the input array", () => {
  const items = [
    { full_name: "a", notifications: [{ updated_at: "2020-01-01T00:00:00Z" }] },
    { full_name: "b", notifications: [{ updated_at: "2020-02-01T00:00:00Z" }] },
  ];
  const snapshot = items.map((i) => i.full_name);
  sortReposByRecency(items, (g) => g.notifications, (g) => g.full_name);
  assert.deepEqual(items.map((i) => i.full_name), snapshot);
});

/* -------------------------------- filterGroups -------------------------------- */

const groups = () => [
  {
    repo_id: 1,
    full_name: "r/1",
    notifications: [
      { thread_id: "a", reason: "mention", updated_at: "2020-01-01T00:00:00Z" },
      { thread_id: "b", reason: "assign", updated_at: "2020-02-01T00:00:00Z" },
    ],
  },
  {
    repo_id: 2,
    full_name: "r/2",
    notifications: [{ thread_id: "c", reason: "mention", updated_at: "2020-03-01T00:00:00Z" }],
  },
];

test("filterGroups narrows notifications, drops empty groups, and sorts by recency", () => {
  const out = filterGroups(groups(), "mention", null);
  assert.equal(out.length, 2);
  assert.equal(out[0].repo_id, 2); // r/2 has the newer matching notification
  assert.equal(out[0].notifications.length, 1);
  assert.equal(out[1].repo_id, 1);
  assert.equal(out[1].notifications.length, 1); // only the "mention" survives
});

test("filterGroups drops groups with no matches", () => {
  const out = filterGroups(groups(), "review_requested", null);
  assert.equal(out.length, 0);
});

test("filterGroups sorts by the FILTERED notifications, not all of a repo's", () => {
  const input = [
    {
      repo_id: 1,
      full_name: "a/has-old-match",
      notifications: [
        { thread_id: "m1", reason: "mention", updated_at: "2020-01-01T00:00:00Z" }, // old match
        { thread_id: "n1", reason: "assign", updated_at: "2020-09-01T00:00:00Z" }, // newer NON-match
      ],
    },
    {
      repo_id: 2,
      full_name: "b/has-new-match",
      notifications: [{ thread_id: "m2", reason: "mention", updated_at: "2020-05-01T00:00:00Z" }],
    },
  ];
  const out = filterGroups(input, "mention", null);
  // Sorting by ALL notifications would lead with repo 1 (newest overall = 2020-09). Sorting
  // by the matching subset must lead with repo 2 (2020-05) over repo 1's match (2020-01).
  assert.deepEqual(out.map((g) => g.repo_id), [2, 1]);
});

test("filterGroups applies the optional repo refinement", () => {
  const out = filterGroups(groups(), "mention", 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].repo_id, 1);
});

test("filterGroups does not mutate the input groups (deep)", () => {
  const input = groups();
  const snapshot = structuredClone(input);
  filterGroups(input, "mention", null);
  assert.deepEqual(input, snapshot);
});
