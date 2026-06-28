import { test } from "node:test";
import assert from "node:assert/strict";

import { pill, iconButton, sourceButton } from "../src/js/ui.js";

/* The shared presentational helpers. Their key contract is that every text field is escaped
 * and the a11y attributes (aria-label, aria-current) are present. `icon` is trusted SVG. */

test("pill escapes its text and applies the class", () => {
  assert.equal(pill("PR", "badge badge--pr"), '<span class="badge badge--pr">PR</span>');
  assert.ok(pill("<x>", "badge").includes("&lt;x&gt;"));
});

test("pill adds an (escaped) title when given one", () => {
  assert.equal(
    pill("private", "badge badge--lock", { title: 'Private "repo"' }),
    '<span class="badge badge--lock" title="Private &quot;repo&quot;">private</span>',
  );
});

test("iconButton bakes in type, aria-label, and a default title", () => {
  const html = iconButton({ icon: "<svg></svg>", label: "Reveal in Finder" });
  assert.ok(html.includes('type="button"'));
  assert.ok(html.includes('class="icon-btn"'));
  assert.ok(html.includes('aria-label="Reveal in Finder"'));
  // Title defaults to the label.
  assert.ok(html.includes('title="Reveal in Finder"'));
  assert.ok(html.includes("<svg></svg>"));
});

test("iconButton escapes the label and supports a distinct title + extra attrs", () => {
  const html = iconButton({
    icon: "I",
    label: 'Mark "x" as done',
    title: "Mark as done",
    className: "n-done",
    attrs: 'data-done-repo="3"',
  });
  assert.ok(html.includes('aria-label="Mark &quot;x&quot; as done"'));
  assert.ok(html.includes('title="Mark as done"'));
  assert.ok(html.includes('class="n-done"'));
  assert.ok(html.includes('data-done-repo="3"'));
});

test("sourceButton renders the source skeleton with an escaped label", () => {
  const html = sourceButton({ icon: "I", label: "Mentions", attrs: 'data-filter="mention"' });
  assert.ok(html.includes('class="source"'));
  assert.ok(html.includes('data-filter="mention"'));
  assert.ok(html.includes('<span class="source-icon" aria-hidden="true">I</span>'));
  assert.ok(html.includes('<span class="source-label">Mentions</span>'));
  // No count badge when neither count nor countKey is given.
  assert.ok(!html.includes("source-count"));
});

test("sourceButton marks the active entry for assistive tech", () => {
  const html = sourceButton({ icon: "I", label: "All", active: true, attrs: 'data-filter="all"' });
  assert.ok(html.includes("source source--active"));
  assert.ok(html.includes('aria-current="true"'));
});

test("sourceButton adds a live count hook via countKey, empty until populated", () => {
  const html = sourceButton({ icon: "I", label: "All", countKey: "all" });
  assert.ok(html.includes('<span class="source-count" data-count="all"></span>'));
});

test("sourceButton bakes a static count and the private-repo lock marker", () => {
  const html = sourceButton({
    icon: "I",
    label: "octo/<repo>",
    labelTitle: "octo/<repo>",
    lock: true,
    className: "repo-source",
    count: "5",
  });
  assert.ok(html.includes("octo/&lt;repo&gt; 🔒"));
  assert.ok(html.includes('title="octo/&lt;repo&gt;"'));
  assert.ok(html.includes('<span class="source-count">5</span>'));
  assert.ok(html.includes("source repo-source"));
});
