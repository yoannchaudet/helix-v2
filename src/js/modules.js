import { $, html } from "./dom.js";
import { isShortcutsOpen } from "./shortcuts.js";
import { closeMenu } from "./menu.js";
import { MODULES, DEFAULT_MODULE_ID, isModuleId, moduleAt } from "./modules-model.js";

/* The module system: Helix's top-level destinations (à la Lightroom's modules). Each module
 * owns a content pane and is reached via the Lightroom-style picker in the title bar. The
 * picker lives in `#module-picker` and is rendered from the `MODULES` registry (the pure
 * data + helpers live in modules-model.js).
 *
 * Settings is intentionally NOT a module — it's a focused full-width *overlay* (see
 * settings.js) that temporarily covers the active module and returns to it on close.
 * Switching modules dismisses that overlay (wired via the `onSwitch` hook from main.js, so
 * this module never imports settings.js and we avoid a circular dependency). */

/** The active module id (resets to the default each launch; not persisted). */
let activeModuleId = DEFAULT_MODULE_ID;

/** Cross-module hooks, set by main.js to avoid import cycles. `onSwitch(id)` fires after a
 *  module becomes active (used to dismiss the Settings overlay). */
const hooks = { onSwitch: null };

/** Wire cross-module reactions without importing their modules (avoids cycles). */
export function configureModules(overrides) {
  Object.assign(hooks, overrides);
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
  document.querySelector(".app")?.setAttribute("data-module", activeModuleId);
}

/** Reflect the active module onto the picker buttons (accent the active one, expose it to
 *  assistive tech via `aria-current`). */
function renderPickerState() {
  for (const btn of document.querySelectorAll(".module-tab")) {
    const active = btn.dataset.module === activeModuleId;
    btn.classList.toggle("module-tab--active", active);
    if (active) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** Switch to a module by id. No-op for an unknown id. Always re-shows the active module pane
 *  and dismisses the Settings overlay (via `onSwitch`), so it doubles as "leave Settings". */
export function switchModule(id) {
  if (!isModuleId(id)) return;
  activeModuleId = id;
  // Dismiss transient UI tied to the outgoing module so it can't linger over the new one:
  // any open context menu/popover (e.g. an inbox row menu) and the Settings overlay.
  closeMenu();
  hooks.onSwitch?.(id);
  showActiveModulePane();
  renderPickerState();
}

/** Render the picker buttons into `#module-picker` and wire clicks + the ⌘N shortcuts.
 *  Call once on DOMContentLoaded. */
export function initModules() {
  const picker = $("#module-picker");
  if (picker) {
    picker.innerHTML = MODULES.map(
      (m) =>
        html`<button type="button" class="module-tab" data-module="${m.id}">${m.label}</button>`,
    ).join("");
    picker.addEventListener("click", (e) => {
      const btn = e.target instanceof Element ? e.target.closest(".module-tab") : null;
      if (btn) switchModule(btn.dataset.module);
    });
  }

  // ⌘1 / ⌘2 jump straight to a module by position (matching the ⌘, Settings convention).
  // Guard like the other global shortcuts: ignore while the shortcuts overlay is modal.
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    if (isShortcutsOpen()) return;
    const mod = moduleAt(Number(e.key) - 1);
    if (mod) {
      e.preventDefault();
      switchModule(mod.id);
    }
  });

  // Paint the initial state (default module pane + picker highlight).
  showActiveModulePane();
  renderPickerState();
}
