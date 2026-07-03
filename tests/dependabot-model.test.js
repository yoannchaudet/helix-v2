import { test } from "node:test";
import assert from "node:assert/strict";

import { filterDependabotGroups, totalPrs, repoDomId } from "../src/js/dependabot-model.js";

/* Pure model logic — no DOM. Covers the repo-refine + recency-sort pipeline and the small
 * helpers the view relies on. */

function group(fullName, prs) {
  return { full_name: fullName, total: prs.length, prs };
}
function pr(id, updated_at) {
  return {
    id,
    number: id,
    title: `PR ${id}`,
    html_url: `https://x/${id}`,
    author: "dependabot[bot]",
    updated_at,
  };
}

const groups = [
  group("octo/a", [pr(1, "2026-01-01T00:00:00Z"), pr(2, "2026-01-03T00:00:00Z")]),
  group("octo/b", [pr(3, "2026-01-02T00:00:00Z")]),
];

test("filterDependabotGroups orders repos by most recent PR, newest first", () => {
  const out = filterDependabotGroups(groups, null);
  // octo/a has a PR updated 01-03 (newest) → it sorts ahead of octo/b (01-02).
  assert.deepEqual(
    out.map((g) => g.full_name),
    ["octo/a", "octo/b"],
  );
});

test("filterDependabotGroups narrows to a single repo when refined", () => {
  const out = filterDependabotGroups(groups, "octo/b");
  assert.equal(out.length, 1);
  assert.equal(out[0].full_name, "octo/b");
});

test("filterDependabotGroups with an unknown repo yields nothing", () => {
  assert.deepEqual(filterDependabotGroups(groups, "octo/missing"), []);
});

test("filterDependabotGroups does not mutate the input", () => {
  const snapshot = JSON.stringify(groups);
  filterDependabotGroups(groups, "octo/a");
  assert.equal(JSON.stringify(groups), snapshot);
});

test("totalPrs sums PRs across groups", () => {
  assert.equal(totalPrs(groups), 3);
  assert.equal(totalPrs([]), 0);
});

test("repoDomId produces a DOM-safe id from a full_name", () => {
  assert.equal(repoDomId("octo/hello"), "dep-repo-octo-hello");
  assert.equal(repoDomId("acme/my.widget_v2"), "dep-repo-acme-my-widget-v2");
});
