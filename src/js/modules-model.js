/* Pure module-registry data + helpers, with no DOM or backend imports so it's unit-testable
 * in the Node test runner (mirrors the inbox-model.js / inbox.js split). modules.js owns the
 * DOM wiring; everything here is pure. */

/** The top-level modules, in picker (and ⌘N) order. `id` is stable; `paneId` is the
 *  `<section class="pane">` the module shows. Settings is intentionally absent — it's an
 *  overlay, not a module. */
export const MODULES = [
  { id: "notifications", label: "Notifications", paneId: "view-notifications" },
  { id: "dependabot", label: "Dependabot", paneId: "view-dependabot" },
];

/** The module shown on launch (state is not persisted across launches). */
export const DEFAULT_MODULE_ID = "notifications";

/** Whether `id` names a real module. */
export function isModuleId(id) {
  return MODULES.some((m) => m.id === id);
}

/** The module at a zero-based position, or null when out of range. Powers the ⌘N jumps
 *  (⌘1 → index 0, ⌘2 → index 1, …). */
export function moduleAt(index) {
  return MODULES[index] ?? null;
}
