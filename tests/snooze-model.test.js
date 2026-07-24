import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SNOOZE_OPTIONS,
  SNOOZE_HINT,
  MORNING_HOUR,
  snoozeUntil,
  fmtSnoozeUntil,
} from "../src/js/snooze-model.js";

/* Pure duration/deadline logic. Everything is computed in local time and persisted as UTC,
 * so the assertions read the resolved Date back in local time. */

const MINUTE = 60_000;

/** Parse a stored deadline back into a local Date. */
function at(optionId, now) {
  return new Date(snoozeUntil(optionId, now));
}

test("snoozeUntil produces a canonical UTC seconds-precision timestamp", () => {
  const until = snoozeUntil("20m", new Date("2026-03-01T12:00:00Z"));
  assert.match(until, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(until, "2026-03-01T12:20:00Z");
});

test("snoozeUntil returns null for an unknown option", () => {
  assert.equal(snoozeUntil("nope"), null);
  assert.equal(snoozeUntil(undefined), null);
});

test("the minute-based options are exact offsets", () => {
  const now = new Date("2026-03-01T12:00:00Z");
  assert.equal(at("20m", now) - now, 20 * MINUTE);
  assert.equal(at("1h", now) - now, 60 * MINUTE);
  assert.equal(at("3h", now) - now, 180 * MINUTE);
});

test("'Tomorrow' is the next calendar day at the morning hour, local time", () => {
  const now = new Date(2026, 2, 1, 22, 45); // local 10:45pm
  const until = at("tomorrow", now);
  assert.equal(until.getDate(), 2);
  assert.equal(until.getHours(), MORNING_HOUR);
  assert.equal(until.getMinutes(), 0);
});

test("'Tomorrow' uses calendar arithmetic, so it survives a DST transition", () => {
  // US spring-forward night (2026-03-08). A naive +24h would land at 10:00, not 09:00.
  const now = new Date(2026, 2, 7, 20, 0);
  const until = at("tomorrow", now);
  assert.equal(until.getDate(), 8);
  assert.equal(until.getHours(), MORNING_HOUR);
});

test("'Next week' is the next Monday morning, never the same day", () => {
  // 2026-03-04 is a Wednesday → Monday the 9th.
  const wednesday = at("next_week", new Date(2026, 2, 4, 15, 0));
  assert.equal(wednesday.getDay(), 1);
  assert.equal(wednesday.getDate(), 9);
  assert.equal(wednesday.getHours(), MORNING_HOUR);

  // From a Monday it's a full week out, not "today".
  const monday = at("next_week", new Date(2026, 2, 9, 8, 0));
  assert.equal(monday.getDay(), 1);
  assert.equal(monday.getDate(), 16);

  // From a Sunday it's the very next day.
  const sunday = at("next_week", new Date(2026, 2, 8, 8, 0));
  assert.equal(sunday.getDay(), 1);
  assert.equal(sunday.getDate(), 9);
});

test("every option resolves to a future deadline", () => {
  const now = new Date(2026, 2, 4, 15, 0);
  for (const { id } of SNOOZE_OPTIONS) {
    assert.ok(at(id, now) > now, `${id} should be in the future`);
  }
});

/* -------------------------------- fmtSnoozeUntil -------------------------------- */

test("fmtSnoozeUntil: empty input is empty, unparseable input is returned unchanged", () => {
  assert.equal(fmtSnoozeUntil(null), "");
  assert.equal(fmtSnoozeUntil(""), "");
  assert.equal(fmtSnoozeUntil("not-a-date"), "not-a-date");
});

test("fmtSnoozeUntil: a lapsed or imminent deadline reads as imminent", () => {
  const now = new Date(2026, 2, 4, 15, 0);
  assert.equal(
    fmtSnoozeUntil(new Date(now.getTime() - MINUTE).toISOString(), now),
    "any moment now",
  );
  assert.equal(
    fmtSnoozeUntil(new Date(now.getTime() + 10_000).toISOString(), now),
    "any moment now",
  );
});

test("fmtSnoozeUntil: sub-hour and same-day deadlines read as offsets", () => {
  const now = new Date(2026, 2, 4, 9, 0);
  assert.equal(fmtSnoozeUntil(new Date(now.getTime() + 18 * MINUTE).toISOString(), now), "in 18m");
  assert.equal(fmtSnoozeUntil(new Date(now.getTime() + 180 * MINUTE).toISOString(), now), "in 3h");
});

test("fmtSnoozeUntil: tomorrow and later this week name the day", () => {
  const now = new Date(2026, 2, 4, 15, 0); // Wednesday
  assert.match(fmtSnoozeUntil(new Date(2026, 2, 5, 9, 0).toISOString(), now), /^tomorrow /);
  const monday = fmtSnoozeUntil(new Date(2026, 2, 9, 9, 0).toISOString(), now);
  assert.ok(!monday.startsWith("tomorrow"));
  assert.ok(!monday.startsWith("in "));
});

test("fmtSnoozeUntil: beyond a week falls back to a date", () => {
  const now = new Date(2026, 2, 4, 15, 0);
  const out = fmtSnoozeUntil(new Date(2026, 3, 4, 9, 0).toISOString(), now);
  assert.ok(out.includes(","), `expected a date-style label, got ${out}`);
});

test("SNOOZE_HINT numbers every option so the digit matches its menu position", () => {
  SNOOZE_OPTIONS.forEach((option, i) => {
    assert.match(SNOOZE_HINT, new RegExp(`${i + 1} ${option.shortLabel}`));
  });
});

test("a fixed duration stays fixed across a DST transition", () => {
  // US fall-back: 2026-11-01 01:00 local repeats, so calendar arithmetic would turn a
  // 3-hour snooze into four real hours.
  const before = new Date("2026-11-01T07:30:00Z"); // 00:30 PDT
  const until = new Date(snoozeUntil("3h", before));
  assert.equal(until.getTime() - before.getTime(), 3 * 60 * 60 * 1000);
});
