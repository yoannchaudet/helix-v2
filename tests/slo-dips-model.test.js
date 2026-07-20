import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dipStatus,
  dipSeverity,
  avatarUrl,
  formatPercent,
  summarize,
  countDipsByRepoId,
  repoDomId,
  groupDipsByRepo,
} from "../src/js/slo-dips-model.js";

function dip(overrides = {}) {
  return {
    comment_id: 1,
    repo_full_name: "github/edge-foundation",
    service: "dns",
    slo_name: "dns/availability/sam",
    dip_date: "2026-04-19",
    percent: 99.967,
    investigated: false,
    ...overrides,
  };
}

/* --------------------------------- dipStatus --------------------------------- */

test("dipStatus reflects the investigated flag", () => {
  assert.equal(dipStatus(dip({ investigated: true })), "investigated");
  assert.equal(dipStatus(dip({ investigated: false })), "pending");
});

/* --------------------------------- dipSeverity -------------------------------- */

test("dipSeverity buckets by how far below target the attainment fell", () => {
  assert.equal(dipSeverity(dip({ percent: 99.9, goal_percent: 99.99 })).level, "low");
  assert.equal(dipSeverity(dip({ percent: 98.5, goal_percent: 99.9 })).level, "medium");
  assert.equal(dipSeverity(dip({ percent: 92.4, goal_percent: 99.9 })).level, "high");
});

test("dipSeverity reports the raw gap and handles a missing goal", () => {
  const withGoal = dipSeverity(dip({ percent: 99, goal_percent: 99.5 }));
  assert.equal(withGoal.level, "medium");
  assert.ok(Math.abs(withGoal.gap - 0.5) < 1e-9);
  const noGoal = dipSeverity(dip({ percent: 99, goal_percent: null }));
  assert.deepEqual(noGoal, { level: "unknown", gap: null });
});

/* ---------------------------------- avatarUrl -------------------------------- */

test("avatarUrl builds a sized github.com avatar URL and encodes the login", () => {
  assert.equal(avatarUrl("yoannchaudet"), "https://github.com/yoannchaudet.png?size=32");
  assert.equal(avatarUrl("a/b", 48), "https://github.com/a%2Fb.png?size=48");
});

/* -------------------------------- formatPercent ------------------------------- */

test("formatPercent trims floating-point noise to three decimals", () => {
  assert.equal(formatPercent(99.967), "99.967%");
  assert.equal(formatPercent(99.99), "99.99%");
  assert.equal(formatPercent(99.98000000001), "99.98%");
});

test("formatPercent handles non-numbers", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(NaN), "—");
});

/* ---------------------------------- summarize --------------------------------- */

test("summarize counts total, investigated and pending", () => {
  const s = summarize([
    dip({ investigated: true }),
    dip({ investigated: false }),
    dip({ investigated: true }),
  ]);
  assert.deepEqual(s, { total: 3, investigated: 2, pending: 1 });
});

/* ----------------------------- countDipsByRepoId ------------------------------ */

test("countDipsByRepoId tallies total and investigated per repo, omitting empty repos", () => {
  const counts = countDipsByRepoId([
    dip({ repo_id: 1, investigated: true }),
    dip({ repo_id: 1, investigated: false }),
    dip({ repo_id: 2, investigated: true }),
  ]);
  assert.deepEqual(counts.get(1), { total: 2, investigated: 1 });
  assert.deepEqual(counts.get(2), { total: 1, investigated: 1 });
  assert.equal(counts.has(3), false);
});

test("countDipsByRepoId returns an empty map for no dips", () => {
  assert.equal(countDipsByRepoId([]).size, 0);
});

/* --------------------------------- repoDomId ---------------------------------- */

test("repoDomId is DOM-safe", () => {
  assert.equal(repoDomId("github/edge-foundation"), "slo-repo-github%2Fedge-foundation");
});

test("repoDomId is injective for repos that differ only by separator", () => {
  assert.notEqual(repoDomId("org/a-b"), repoDomId("org/a.b"));
  assert.notEqual(repoDomId("org/a_b"), repoDomId("org/a-b"));
});

/* ------------------------------- groupDipsByRepo ------------------------------ */

test("groupDipsByRepo groups by repo and orders by most recent dip", () => {
  const dips = [
    dip({ comment_id: 1, repo_full_name: "org/a", dip_date: "2026-04-10" }),
    dip({ comment_id: 2, repo_full_name: "org/b", dip_date: "2026-05-01" }),
    dip({ comment_id: 3, repo_full_name: "org/a", dip_date: "2026-04-20" }),
  ];
  const groups = groupDipsByRepo(dips);
  assert.deepEqual(
    groups.map((g) => g.repoFullName),
    ["org/b", "org/a"],
  );
  const a = groups.find((g) => g.repoFullName === "org/a");
  assert.equal(a.total, 2);
  assert.equal(a.latestDipDate, "2026-04-20");
  // Preserves input order within the group (backend already sorts dip_date DESC).
  assert.deepEqual(
    a.dips.map((d) => d.comment_id),
    [1, 3],
  );
});

test("groupDipsByRepo tie-breaks equal latest dates by repo name", () => {
  const dips = [
    dip({ repo_full_name: "org/z", dip_date: "2026-05-01" }),
    dip({ repo_full_name: "org/a", dip_date: "2026-05-01" }),
  ];
  assert.deepEqual(
    groupDipsByRepo(dips).map((g) => g.repoFullName),
    ["org/a", "org/z"],
  );
});

test("groupDipsByRepo does not mutate its input", () => {
  const dips = [dip()];
  const copy = JSON.parse(JSON.stringify(dips));
  groupDipsByRepo(dips);
  assert.deepEqual(dips, copy);
});
