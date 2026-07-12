/* Pure list-model utilities shared across modules: recency-based sorting and timestamp
 * extraction for grouped item lists. No DOM, no mutable state — every function takes its
 * inputs and returns new data. Extracted from inbox-model.js so Dependabot (and future
 * modules) can reuse them without importing inbox-specific code. */

/** Most recent `updated_at` in an item list (ISO-8601 UTC strings compare lexically,
 *  so the newest is the max). Empty list → "". */
export function latestUpdatedAt(items) {
  let max = "";
  for (const item of items) {
    if (item.updated_at > max) max = item.updated_at;
  }
  return max;
}

/** Order repo-like items most-recent-first by their newest (matching) item, with
 *  name as a deterministic tie-breaker. Recency is computed once per item (not on every
 *  comparison), and names compare by code point so the order is stable across locales. */
export function sortReposByRecency(items, getItems, getName) {
  return items
    .map((item) => ({
      item,
      recency: latestUpdatedAt(getItems(item)),
      name: getName(item),
    }))
    .sort((a, b) => {
      if (a.recency !== b.recency) return a.recency < b.recency ? 1 : -1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return 0;
    })
    .map((x) => x.item);
}
