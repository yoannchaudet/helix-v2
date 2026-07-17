import { $, html } from "./dom.js";
import { invoke } from "./api.js";
import { isShortcutsOpen } from "./shortcuts.js";
import { registerShortcutGroups } from "./shortcuts.js";
import { closeMenu } from "./menu.js";
import { MODULES, DEFAULT_MODULE_ID, isModuleId, moduleAt } from "./modules-model.js";

/* The module system: Helix's top-level destinations. Each module owns a content pane and is
 * reached via the segmented module bar in the title bar. The picker lives in
 * `#module-picker` and is rendered from the `MODULES` registry (the pure data + helpers live
 * in modules-model.js).
 *
 * Settings is intentionally NOT a module — it's a focused full-width *overlay* (see
 * settings.js) that temporarily covers the active module and returns to it on close.
 *
 * ## Module contract
 *
 * Modules register their capabilities via `registerModule(id, config)`. The contract is:
 *
 *   init()       — Called once during `initModules()` (DOMContentLoaded). Wire DOM
 *                  listeners and one-time setup here.
 *   load()       — Called once after init to perform the initial data load.
 *   activate()   — Called when the module becomes visible (module switch or restore).
 *                  Use for staleness-gated syncs, on-return announcements, etc.
 *   deactivate() — Called when the module is hidden by another module. Use for clearing
 *                  stale announcement queues, pausing timers, etc.
 *   sidebarSelector — CSS selector for this module's sidebar nav. modules.js toggles
 *                  it via the `hidden` attribute as the active module changes.
 *   shortcuts    — Shortcut groups contributed to the shortcuts overlay.
 *
 * All callbacks are optional. Modules that don't register still work — they just don't get
 * lifecycle calls.
 *
 * The app shell can also register hooks via `configureModules({ onBeforeSwitch })` for
 * cross-cutting concerns that are NOT module-specific (e.g. dismissing the Settings
 * overlay). These fire before the module lifecycle. */

/** The active module id. Defaults to `DEFAULT_MODULE_ID`; `restoreLastModule()` reinstates
 *  the previously opened module on launch. */
let activeModuleId = DEFAULT_MODULE_ID;

/** Registered module config, keyed by module id.
 *  Shape: `{ [id]: { init?, load?, activate?, deactivate?, sidebarSelector?, shortcuts? } }`. */
const registry = {};

/** App-shell hooks, set by main.js to avoid import cycles. `onBeforeSwitch()` fires
 *  before every module switch (used to dismiss the Settings overlay). */
const hooks = { onBeforeSwitch: null };

/** Serializes `set_last_module` writes so rapid switches persist in switch order. */
let persistChain = Promise.resolve();

/** Wire app-shell reactions (not module-specific) without importing their modules.
 *  `onBeforeSwitch()` fires before every switch — used to dismiss the Settings overlay. */
export function configureModules(overrides) {
  Object.assign(hooks, overrides);
}

/** Register a module's config. Call at module init time (before `initModules`).
 *
 * @param {string} id       The module id (must match a MODULES entry).
 * @param {Object} config
 * @param {Function} [config.init]       One-time setup (DOMContentLoaded).
 * @param {Function} [config.load]       Initial data load (called after all inits).
 * @param {Function} [config.activate]   Called when the module becomes visible.
 * @param {Function} [config.deactivate] Called when the module is hidden.
 * @param {string} [config.sidebarSelector] CSS selector for this module sidebar.
 * @param {Array} [config.shortcuts]     Shortcut groups for the shortcuts overlay.
 */
export function registerModule(id, config) {
  if (!isModuleId(id)) throw new Error(`registerModule: unknown module id "${id}"`);
  if (config?.shortcuts != null && !Array.isArray(config.shortcuts)) {
    throw new Error(`registerModule: "${id}" shortcuts must be an array`);
  }
  registry[id] = { ...config };
}

function switchTrigger(options) {
  return options?.trigger || "unknown";
}

/** The currently active module's id. */
export function getActiveModule() {
  return activeModuleId;
}

/** Hide every module pane. Used when opening the Settings overlay so no module shows
 *  beneath it (Settings spans the full window). */
export function hideModulePanes() {
  for (const m of MODULES) {
    const pane = $(`#${m.paneId}`);
    if (pane) pane.hidden = true;
  }
}

/** Show the active module's pane and hide the others. The single source of truth for which
 *  module pane is visible; called on switch and when the Settings overlay closes. */
export function showActiveModulePane() {
  for (const m of MODULES) {
    const pane = $(`#${m.paneId}`);
    if (pane) pane.hidden = m.id !== activeModuleId;
  }
  for (const sidebar of document.querySelectorAll(".sidebar-module")) {
    sidebar.hidden = true;
  }
  const sidebarSelector = registry[activeModuleId]?.sidebarSelector;
  if (sidebarSelector) {
    const sidebar = $(sidebarSelector);
    if (sidebar) sidebar.hidden = false;
  }
  document.querySelector(".app")?.setAttribute("data-module", activeModuleId);
}

/** Reflect the active module onto the picker buttons and sliding visual indicator. */
function renderPickerState() {
  const activeIndex = MODULES.findIndex((module) => module.id === activeModuleId);
  const picker = $("#module-picker");
  if (picker) {
    picker.dataset.activeIndex = String(activeIndex);
    picker.style.setProperty("--module-index", String(activeIndex));
  }

  for (const btn of document.querySelectorAll(".module-tab")) {
    const active = btn.dataset.module === activeModuleId;
    btn.classList.toggle("module-tab--active", active);
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** Switch to a module by id. No-op for an unknown id. Always re-shows the active module pane
 *  and dismisses the Settings overlay (via `onBeforeSwitch`), so it doubles as "leave Settings".
 *  Calls `deactivate()` on the outgoing module and `activate()` on the incoming one. */
export function switchModule(id, options = {}) {
  if (!isModuleId(id)) return;
  const outgoing = activeModuleId;
  const trigger = switchTrigger(options);
  // App-shell hook fires first (dismisses Settings, closes transient UI).
  hooks.onBeforeSwitch?.();
  // Dismiss transient UI tied to the outgoing module so it can't linger over the new one:
  // any open context menu/popover (e.g. an inbox row menu).
  // Close the menu WITHOUT restoring focus: its return target is inside the outgoing module,
  // which `showActiveModulePane()` is about to hide — restoring focus there would strand it
  // on a hidden element. Letting focus fall to <body> is the safe, stable outcome.
  closeMenu(false);
  // Lifecycle: deactivate the outgoing module (only if actually changing modules).
  if (outgoing !== id) {
    registry[outgoing]?.deactivate?.({ from: outgoing, to: id, trigger });
  }
  activeModuleId = id;
  showActiveModulePane();
  renderPickerState();
  // Lifecycle: activate the incoming module (only if actually changed, to avoid re-running
  // expensive activation on a same-module click that just dismisses Settings).
  if (outgoing !== id) {
    registry[id]?.activate?.({ from: outgoing, to: id, trigger });
  }
  // Persist the choice so the next launch reopens this module. Writes are chained (not just
  // fire-and-forget) so a slow earlier write can't land after a later one and restore a stale
  // module on the next launch. A failed write just means we fall back to the default.
  persistChain = persistChain
    .catch(() => {})
    .then(() => invoke("set_last_module", { moduleId: id }).catch(() => {}));
}

/** Restore the last opened module from persisted state. Call once on startup, before the
 *  window is shown, so we don't flash the default module first. No-op if nothing was saved
 *  or the saved id is unknown/already the default. */
export async function restoreLastModule() {
  try {
    const id = await invoke("get_last_module");
    if (isModuleId(id) && id !== activeModuleId) switchModule(id, { trigger: "restore" });
  } catch {
    /* fall back to the default module */
  }
}

/** Re-activate the currently active module without switching. Used when external state
 *  changes (e.g. authentication) mean the active module should re-run its activation
 *  logic (staleness-gated syncs, etc.). No-op if nothing is registered. */
export function activateCurrentModule() {
  registry[activeModuleId]?.activate?.();
}

/** Render the picker indicator + buttons into `#module-picker` and wire clicks + the ⌘N
 *  shortcuts.
 *  Then call each registered module's `init()` and `load()`. Call once on DOMContentLoaded,
 *  AFTER all modules have called `registerModule`. */
export function initModules() {
  const picker = $("#module-picker");
  if (picker) {
    picker.style.setProperty("--module-count", String(MODULES.length));
    picker.innerHTML = [
      html`<span class="module-picker-indicator" aria-hidden="true"></span>`,
      ...MODULES.map(
        (m) =>
          html`<button type="button" class="module-tab" data-module="${m.id}">${m.label}</button>`,
      ),
    ].join("");
    picker.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest(".module-tab") : null;
      if (btn) switchModule(btn.dataset.module, { trigger: "picker" });
    });
  }

  // ⌘N jumps straight to a module by registry position (matching the ⌘, Settings convention).
  // Guard like the other global shortcuts: ignore while the shortcuts overlay is modal.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (isShortcutsOpen()) return;
    const mod = moduleAt(Number(e.key) - 1);
    if (mod) {
      e.preventDefault();
      switchModule(mod.id, { trigger: "shortcut" });
    }
  });

  // Module lifecycle: init each registered module, then load.
  for (const m of MODULES) {
    const groups = registry[m.id]?.shortcuts;
    if (groups?.length) registerShortcutGroups(groups);
  }
  for (const m of MODULES) {
    registry[m.id]?.init?.();
  }
  for (const m of MODULES) {
    registry[m.id]?.load?.();
  }

  // Paint the initial state (default module pane + picker highlight).
  showActiveModulePane();
  renderPickerState();

  // Activate the default module so it runs its on-open logic (if any). If
  // `restoreLastModule` later switches to a different module, that module's activate will
  // fire via switchModule (and this one's deactivate), so there's no double-activation.
  registry[activeModuleId]?.activate?.();
}
