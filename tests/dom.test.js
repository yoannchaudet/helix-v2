import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, html, rawHtml } from "../src/js/dom.js";

// Only the pure HTML helpers are unit-tested here; the rest of dom.js (flash/toast/announce/
// copyText) touches the DOM/clipboard and is exercised manually in the app.

test("escapeHtml escapes all five HTML-sensitive characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("escapeHtml leaves safe text unchanged", () => {
  assert.equal(escapeHtml("owner/repo #123"), "owner/repo #123");
});

test("escapeHtml coerces non-strings", () => {
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml(null), "null");
});

test("escapeHtml neutralizes a script-injection attempt", () => {
  assert.equal(
    escapeHtml("<script>alert('x')</script>"),
    "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
  );
});

test("html escapes interpolated values by default", () => {
  assert.equal(html`<p>${`<b>x</b>`}</p>`, "<p>&lt;b&gt;x&lt;/b&gt;</p>");
});

test("html preserves trusted raw fragments", () => {
  assert.equal(html`<p>${rawHtml("<strong>x</strong>")}</p>`, "<p><strong>x</strong></p>");
});
