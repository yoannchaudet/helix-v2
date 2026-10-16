import { test } from "node:test";
import assert from "node:assert/strict";

import {
  latestUpdatedAt,
  sortReposByRecency,
  preservePreferredOrder,
  focusNeighborAfterRemoval,
} from "../src/js/list-kit-model.js";

/* ------------------------------ latestUpdatedAt ------------------------------ */

test("latestUpdatedAt: returns the most recent updated_at", () => {
  const items = [
    { updated_at: "2024-01-01T00:00:00Z" },
    { updated_at: "2024-06-15T12:00:00Z" },
    { updated_at: "2024-03-10T08:00:00Z" },
  ];
  assert.equal(latestUpdatedAt(items), "2024-06-15T12:00:00Z");
});

test("latestUpdatedAt: returns empty string for empty list", () => {
  assert.equal(latestUpdatedAt([]), "");
});

test("latestUpdatedAt: single item returns that item's timestamp", () => {
  assert.equal(latestUpdatedAt([{ updated_at: "2024-01-01T00:00:00Z" }]), "2024-01-01T00:00:00Z");
});

/* ------------------------------ sortReposByRecency ------------------------------ */

test("sortReposByRecency: orders most-recent first", () => {
  const repos = [
    { name: "old-repo", items: [{ updated_at: "2024-01-01T00:00:00Z" }] },
    { name: "new-repo", items: [{ updated_at: "2024-06-01T00:00:00Z" }] },
    { name: "mid-repo", items: [{ updated_at: "2024-03-01T00:00:00Z" }] },
  ];
  const sorted = sortReposByRecency(
    repos,
    (r) => r.items,
    (r) => r.name,
  );
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["new-repo", "mid-repo", "old-repo"],
  );
});

test("sortReposByRecency: ties broken by name (ascending code-point)", () => {
  const repos = [
    { name: "zebra", items: [{ updated_at: "2024-01-01T00:00:00Z" }] },
    { name: "alpha", items: [{ updated_at: "2024-01-01T00:00:00Z" }] },
  ];
  const sorted = sortReposByRecency(
    repos,
    (r) => r.items,
    (r) => r.name,
  );
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["alpha", "zebra"],
  );
});

test("sortReposByRecency: empty items list gets empty recency", () => {
  const repos = [
    { name: "has-items", items: [{ updated_at: "2024-01-01T00:00:00Z" }] },
    { name: "no-items", items: [] },
  ];
  const sorted = sortReposByRecency(
    repos,
    (r) => r.items,
    (r) => r.name,
  );
  assert.equal(sorted[0].name, "has-items");
  assert.equal(sorted[1].name, "no-items");
});

test("sortReposByRecency: does not mutate input", () => {
  const repos = [
    { name: "b", items: [{ updated_at: "2024-06-01T00:00:00Z" }] },
    { name: "a", items: [{ updated_at: "2024-01-01T00:00:00Z" }] },
  ];
  const original = [...repos];
  sortReposByRecency(
    repos,
    (r) => r.items,
    (r) => r.name,
  );
  assert.deepEqual(repos, original);
});

/* -------------------------- preservePreferredOrder -------------------------- */

test("preservePreferredOrder: keeps known items pinned and appends new items", () => {
  const items = [{ id: 3 }, { id: 2 }, { id: 4 }, { id: 1 }];
  const ordered = preservePreferredOrder(items, [1, 2, 3], (item) => item.id);
  assert.deepEqual(
    ordered.map((item) => item.id),
    [1, 2, 3, 4],
  );
});

test("preservePreferredOrder: drops missing ids without mutating input", () => {
  const items = [{ id: 2 }, { id: 1 }];
  const original = [...items];
  const ordered = preservePreferredOrder(items, [1, 3, 2], (item) => item.id);
  assert.deepEqual(
    ordered.map((item) => item.id),
    [1, 2],
  );
  assert.deepEqual(items, original);
});

/* -------------------------- focusNeighborAfterRemoval -------------------------- */

test("focusNeighborAfterRemoval: picks the next surviving item after removed block", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const survivor = focusNeighborAfterRemoval(items, ["b", "c"], (item) => item.id);
  assert.equal(survivor?.id, "d");
});

test("focusNeighborAfterRemoval: falls back to previous survivor when no next item", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const survivor = focusNeighborAfterRemoval(items, ["b", "c"], (item) => item.id);
  assert.equal(survivor?.id, "a");
});

test("focusNeighborAfterRemoval: returns null when removed ids are not visible", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const survivor = focusNeighborAfterRemoval(items, ["x"], (item) => item.id);
  assert.equal(survivor, null);
});

test("focusNeighborAfterRemoval: returns null when no survivors remain", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const survivor = focusNeighborAfterRemoval(items, ["a", "b"], (item) => item.id);
  assert.equal(survivor, null);
});
