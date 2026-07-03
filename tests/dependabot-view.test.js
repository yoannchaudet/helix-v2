import { test } from "node:test";
import assert from "node:assert/strict";

import { prRow, repoHeader, repoSection } from "../src/js/dependabot-view.js";

/* These render pure HTML strings, so they're unit-testable without a DOM. The most important
 * properties: every interpolated field (which is untrusted GitHub data) is HTML-escaped, the
 * merge-readiness pill maps correctly, and the read-only rows carry NO bookmark/done affordances. */

const basePr = {
  id: 101,
  number: 40,
  title: "Bump lodash",
  html_url: "https://github.com/octo/hello/pull/40",
  author: "dependabot[bot]",
  updated_at: "2026-01-01T00:00:00Z",
  mergeable_state: "clean",
};

test("prRow renders an openable row with the PR number, url, and PR badge", () => {
  const row = prRow(basePr);
  assert.ok(row.includes("n-row--openable"));
  assert.ok(row.includes('data-pr-id="101"'));
  assert.ok(row.includes('data-url="https://github.com/octo/hello/pull/40"'));
  assert.ok(row.includes('role="link"'));
  assert.ok(row.includes("#40"));
  assert.ok(row.includes("badge--pr"));
});

test("prRow shows the merge-readiness pill for the mergeable_state", () => {
  assert.ok(prRow({ ...basePr, mergeable_state: "clean" }).includes("merge--clean"));
  assert.ok(prRow({ ...basePr, mergeable_state: "blocked" }).includes("merge--blocked"));
  // unknown/null → no pill (GitHub computes it lazily).
  assert.ok(!prRow({ ...basePr, mergeable_state: null }).includes("n-state"));
  assert.ok(!prRow({ ...basePr, mergeable_state: "unknown" }).includes("n-state"));
});

test("prRow marks a bot author and drops the [bot] suffix", () => {
  const row = prRow(basePr);
  assert.ok(row.includes("n-author--bot"));
  assert.ok(row.includes("dependabot"));
  assert.ok(!row.includes("dependabot[bot]</span>"));
});

test("prRow escapes untrusted fields", () => {
  const row = prRow({ ...basePr, title: "<img src=x onerror=alert(1)>" });
  assert.ok(!row.includes("<img src=x"));
  assert.ok(row.includes("&lt;img"));
});

test("prRow has no bookmark or mark-done affordance (read-only)", () => {
  const row = prRow(basePr);
  assert.ok(!row.includes("n-bookmark"));
  assert.ok(!row.includes("n-done"));
});

test("repoHeader shows the repo name, its PR count, and no mark-done control", () => {
  const header = repoHeader({ full_name: "octo/hello", prs: [basePr, { ...basePr, id: 2 }] });
  assert.ok(header.includes("octo/hello"));
  assert.ok(header.includes('class="repo-counts">2<'));
  assert.ok(!header.includes("repo-done"));
});

test("repoSection wraps rows in a labeled group tied to its heading", () => {
  const section = repoSection({ full_name: "octo/hello", prs: [basePr] });
  assert.ok(section.includes('role="group"'));
  assert.ok(section.includes('aria-labelledby="dep-repo-octo-hello"'));
  assert.ok(section.includes('id="dep-repo-octo-hello"'));
  assert.ok(section.includes("n-list"));
});
