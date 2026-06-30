import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODULES,
  DEFAULT_MODULE_ID,
  isModuleId,
  moduleAt,
} from "../src/js/modules-model.js";

/* --------------------------------- MODULES -------------------------------- */
test("MODULES lists the expected top-level modules in picker order", () => {
  assert.deepEqual(
    MODULES.map((m) => m.id),
    ["notifications", "dependabot"],
  );
});

test("each module declares a label and a pane id", () => {
  for (const m of MODULES) {
    assert.ok(m.label, `${m.id} has a label`);
    assert.ok(m.paneId, `${m.id} has a paneId`);
  }
});

test("Settings is not a module (it's an overlay)", () => {
  assert.equal(isModuleId("settings"), false);
});

test("the default module exists in the registry", () => {
  assert.ok(isModuleId(DEFAULT_MODULE_ID));
});

/* -------------------------------- isModuleId ------------------------------ */
test("isModuleId recognizes real modules and rejects unknown ids", () => {
  assert.equal(isModuleId("notifications"), true);
  assert.equal(isModuleId("dependabot"), true);
  assert.equal(isModuleId("nope"), false);
  assert.equal(isModuleId(undefined), false);
});

/* --------------------------------- moduleAt ------------------------------- */
test("moduleAt maps ⌘N positions to modules (0-based)", () => {
  assert.equal(moduleAt(0).id, "notifications"); // ⌘1
  assert.equal(moduleAt(1).id, "dependabot"); // ⌘2
});

test("moduleAt returns null for out-of-range or non-integer positions", () => {
  assert.equal(moduleAt(-1), null);
  assert.equal(moduleAt(MODULES.length), null);
  assert.equal(moduleAt(NaN), null);
});
