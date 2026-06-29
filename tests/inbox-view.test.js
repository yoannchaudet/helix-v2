import { test } from "node:test";
import assert from "node:assert/strict";

import {
  subjectBadge,
  stateBadge,
  notificationRow,
  repoHeader,
  repoSection,
  authorTag,
} from "../src/js/inbox-view.js";

/* These render pure HTML strings, so they're unit-testable without a DOM. The most
 * important property is that every interpolated field is HTML-escaped (the rows display
 * untrusted GitHub data), alongside the openable/non-openable structural branches. */

const baseNotification = {
  thread_id: "t1",
  subject_type: "PullRequest",
  subject_title: "Fix the bug",
  subject_number: 42,
  subject_state: "open",
  subject_html_url: "https://github.com/o/r/pull/42",
  reason: "review_requested",
  updated_at: "2026-01-01T00:00:00Z",
};

test("notificationRow adds n-row--new only when is_new is set", () => {
  const flagged = notificationRow({ ...baseNotification, is_new: true });
  assert.ok(flagged.includes("n-row--new"));
  const plain = notificationRow({ ...baseNotification, is_new: false });
  assert.ok(!plain.includes("n-row--new"));
  assert.ok(!notificationRow(baseNotification).includes("n-row--new"));
});

test("notificationRow shows a filled bookmark + pressed state when bookmarked", () => {
  const on = notificationRow({ ...baseNotification, bookmarked: true });
  assert.ok(on.includes("n-row--bookmarked"));
  assert.ok(on.includes("n-bookmark is-on"));
  assert.ok(on.includes('aria-pressed="true"'));
  const off = notificationRow(baseNotification);
  assert.ok(!off.includes("n-row--bookmarked"));
  assert.ok(off.includes('aria-pressed="false"'));
});

test("notificationRow hides the mark-as-done button (keeps a spacer) for done rows", () => {
  const done = notificationRow({ ...baseNotification, is_done: true });
  assert.ok(done.includes("n-done-spacer"));
  assert.ok(!done.includes("Mark as done"));
  assert.ok(done.includes('data-done="true"'));
  const active = notificationRow(baseNotification);
  assert.ok(active.includes("Mark as done"));
  assert.ok(!active.includes("n-done-spacer"));
  assert.ok(!active.includes("data-done"));
});

test("subjectBadge maps a known type to its label + class", () => {
  assert.equal(subjectBadge("PullRequest"), '<span class="badge badge--pr">PR</span>');
  assert.equal(subjectBadge("Issue"), '<span class="badge badge--issue">Issue</span>');
});

test("subjectBadge falls back to the (escaped) raw type for unknown subjects", () => {
  assert.equal(
    subjectBadge("<weird>"),
    '<span class="badge badge--other">&lt;weird&gt;</span>',
  );
});

test("stateBadge renders a pill only for open/closed/merged", () => {
  assert.equal(stateBadge("open"), '<span class="state state--open">Open</span>');
  assert.equal(stateBadge("merged"), '<span class="state state--merged">Merged</span>');
  assert.equal(stateBadge("unresolved"), "");
  assert.equal(stateBadge(null), "");
});

test("notificationRow escapes untrusted fields (title, url, thread id)", () => {
  const row = notificationRow({
    ...baseNotification,
    thread_id: 't"1',
    subject_title: '<img src=x onerror=alert(1)>',
    subject_html_url: 'https://e.x/"onmouseover="alert(1)',
  });
  assert.ok(!row.includes("<img src=x"), "raw HTML title must not appear unescaped");
  assert.ok(row.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(row.includes('data-thread-id="t&quot;1"'));
  assert.ok(row.includes("&quot;onmouseover=&quot;alert(1)"));
});

test("notificationRow marks rows with a URL as openable, and bare rows as not", () => {
  const openable = notificationRow(baseNotification);
  assert.ok(openable.includes("n-row--openable"));
  assert.ok(openable.includes('role="link"'));
  assert.ok(openable.includes('tabindex="0"'));
  assert.ok(openable.includes('data-url="https://github.com/o/r/pull/42"'));

  const bare = notificationRow({ ...baseNotification, subject_html_url: null });
  assert.ok(!bare.includes("n-row--openable"));
  assert.ok(!bare.includes('role="link"'));
  assert.ok(!bare.includes("data-url"));
});

test("notificationRow shows the subject number only when present", () => {
  assert.ok(notificationRow(baseNotification).includes('<span class="n-number">#42</span>'));
  assert.ok(
    !notificationRow({ ...baseNotification, subject_number: null }).includes("n-number"),
  );
});

test("notificationRow shows the subject author only when present, and escapes it", () => {
  const withAuthor = notificationRow({ ...baseNotification, subject_author: "octocat" });
  assert.ok(withAuthor.includes('<span class="n-author"'));
  assert.ok(withAuthor.includes(">octocat</span>"));

  assert.ok(
    !notificationRow({ ...baseNotification, subject_author: null }).includes("n-author"),
  );
  assert.ok(!notificationRow(baseNotification).includes("n-author"));

  const evil = notificationRow({
    ...baseNotification,
    subject_author: '<img src=x onerror=alert(1)>',
  });
  assert.ok(!evil.includes("<img src=x"), "raw HTML author must not appear unescaped");
  assert.ok(evil.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("authorTag renders a person plainly (no bot icon)", () => {
  const tag = authorTag("octocat");
  assert.ok(tag.includes('class="n-author"'));
  assert.ok(!tag.includes("n-author--bot"));
  assert.ok(!tag.includes("n-bot-icon"));
  assert.ok(tag.includes(">octocat</span>"));
  assert.ok(tag.includes('title="Author: octocat"'));
});

test("authorTag flags a [bot] login, strips the suffix, and adds a robot icon", () => {
  const tag = authorTag("dependabot[bot]");
  assert.ok(tag.includes("n-author--bot"));
  assert.ok(tag.includes('class="n-bot-icon"'));
  assert.ok(tag.includes("<svg"));
  // The visible name drops the [bot] suffix...
  assert.ok(tag.includes(">dependabot</span>"));
  // ...but the full login is preserved in the tooltip (escaped).
  assert.ok(tag.includes('title="Bot: dependabot[bot]"'));
});

test("authorTag returns empty string for a missing author", () => {
  assert.equal(authorTag(null), "");
  assert.equal(authorTag(undefined), "");
  assert.equal(authorTag(""), "");
});

test("authorTag escapes the login (including for bots)", () => {
  const tag = authorTag('<x>[bot]');
  assert.ok(!tag.includes("<x>"), "raw HTML must not appear unescaped");
  assert.ok(tag.includes("&lt;x&gt;"));
  assert.ok(tag.includes("n-bot-icon"));
});

test("notificationRow gives the done button a per-row accessible name", () => {
  const row = notificationRow(baseNotification);
  assert.ok(row.includes('aria-label="Mark &quot;Fix the bug&quot; as done"'));
});

test("repoHeader escapes the repo name and shows the filtered count", () => {
  const html = repoHeader({
    repo_id: 7,
    full_name: "o/<repo>",
    private: true,
    notifications: [1, 2, 3],
  });
  assert.ok(html.includes('id="repo-h-7"'));
  assert.ok(html.includes("o/&lt;repo&gt;"));
  assert.ok(html.includes('<span class="repo-counts">3</span>'));
  assert.ok(html.includes("badge--lock"));
});

test("repoSection ties the list to its heading and renders each row", () => {
  const html = repoSection({
    repo_id: 7,
    full_name: "o/r",
    private: false,
    notifications: [baseNotification, { ...baseNotification, thread_id: "t2" }],
  });
  assert.ok(html.includes('role="group"'));
  assert.ok(html.includes('aria-labelledby="repo-h-7"'));
  assert.ok(html.includes('data-thread-id="t1"'));
  assert.ok(html.includes('data-thread-id="t2"'));
});
