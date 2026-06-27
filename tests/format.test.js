import { test } from "node:test";
import assert from "node:assert/strict";

import { fmtTimestamp, relTime } from "../src/js/format.js";

/* --------------------------------- fmtTimestamp --------------------------------- */

test("fmtTimestamp: null/empty becomes 'never'", () => {
  assert.equal(fmtTimestamp(null), "never");
  assert.equal(fmtTimestamp(""), "never");
  assert.equal(fmtTimestamp(undefined), "never");
});

test("fmtTimestamp: an unparseable value is returned unchanged", () => {
  assert.equal(fmtTimestamp("not-a-date"), "not-a-date");
});

test("fmtTimestamp: a valid timestamp is formatted (not 'never', not the raw input)", () => {
  const out = fmtTimestamp("2020-01-02T03:04:05Z");
  assert.equal(typeof out, "string");
  assert.notEqual(out, "never");
  assert.notEqual(out, "2020-01-02T03:04:05Z");
});

test("fmtTimestamp: a valid timestamp is rendered via Date.toLocaleString", (t) => {
  // Stub the locale formatter so the assertion isn't locale/timezone dependent, and to prove
  // a parseable value actually goes through toLocaleString.
  t.mock.method(Date.prototype, "toLocaleString", () => "FORMATTED");
  assert.equal(fmtTimestamp("2020-01-02T03:04:05Z"), "FORMATTED");
});

/* ------------------------------------ relTime ----------------------------------- */

/** Run `fn` with `Date.now()` pinned to a fixed instant so relative-time boundaries are
 *  deterministic. Stubs `Date.now` directly (which is all `relTime` reads) rather than the
 *  newer `node:test` timer mocking, for portability; `new Date(<specific iso>)` parsing is
 *  untouched. */
function atFixedNow(fn) {
  const now = new Date("2020-06-15T12:00:00Z").getTime();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    fn(now);
  } finally {
    Date.now = realNow;
  }
}

const iso = (ms) => new Date(ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("relTime: empty input returns ''", () => {
  assert.equal(relTime(""), "");
  assert.equal(relTime(null), "");
});

test("relTime: an unparseable value is returned unchanged", () => {
  assert.equal(relTime("not-a-date"), "not-a-date");
});

test("relTime: seconds bucket and the 60s boundary", () => {
  atFixedNow((now) => {
    assert.equal(relTime(iso(now - 5 * SEC)), "just now");
    assert.equal(relTime(iso(now - 59 * SEC)), "just now");
    assert.equal(relTime(iso(now - 60 * SEC)), "1m ago");
  });
});

test("relTime: minutes, hours, days, months, years buckets", () => {
  atFixedNow((now) => {
    assert.equal(relTime(iso(now - 5 * MIN)), "5m ago");
    assert.equal(relTime(iso(now - 90 * MIN)), "1h ago"); // floor(90/60) = 1
    assert.equal(relTime(iso(now - 25 * HOUR)), "1d ago");
    assert.equal(relTime(iso(now - 40 * DAY)), "1mo ago"); // floor(40/30) = 1
    assert.equal(relTime(iso(now - 400 * DAY)), "1y ago"); // 13 months → floor(13/12) = 1
  });
});

test("relTime: exact bucket thresholds roll over (not off-by-one)", () => {
  atFixedNow((now) => {
    // Just below each threshold stays in the lower bucket; exactly at it rolls over.
    assert.equal(relTime(iso(now - 59 * MIN)), "59m ago");
    assert.equal(relTime(iso(now - 60 * MIN)), "1h ago");
    assert.equal(relTime(iso(now - 23 * HOUR)), "23h ago");
    assert.equal(relTime(iso(now - 24 * HOUR)), "1d ago");
    assert.equal(relTime(iso(now - 29 * DAY)), "29d ago");
    assert.equal(relTime(iso(now - 30 * DAY)), "1mo ago");
    assert.equal(relTime(iso(now - 360 * DAY)), "1y ago"); // 12 months → floor(12/12) = 1
  });
});

test("relTime: a future timestamp is clamped to 'just now'", () => {
  atFixedNow((now) => {
    assert.equal(relTime(iso(now + 10 * MIN)), "just now");
  });
});
