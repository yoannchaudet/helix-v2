/* Shared list-view controller helpers: reusable factory functions for the focus-preserve,
 * hover-track, keyboard-navigation, and kbd-focus-ring patterns that every Helix module's
 * item list needs. Each factory returns a small API object; the calling module wires it
 * into its container at init time.
 *
 * DOM-dependent but stateless across modules: each factory captures its container selector
 * and row selectors at creation time, so two modules can use separate instances without
 * interference.
 *
 * Design constraints (from AGENT.md):
 *  - Factory functions, not classes (matches the codebase's closure/function style).
 *  - Config-driven but narrow: only the parameters that actually differ between modules.
 *  - No app-level state; each module owns its own data and rendering. */

import { $ } from "./dom.js";

/* ────────────────────────────── Hover manager ──────────────────────────────
 *
 * Tracks which row (and optional header) is hovered via a JS-managed class instead of
 * CSS `:hover`. In macOS WKWebView a wholesale re-render under a stationary cursor
 * leaves `:hover` stuck on the new node — its `mouseout` never fires — so we instead
 * mark the hovered row/header with a class via delegated listeners on a stable container.
 *
 * State lives in the DOM (the class itself), never a JS reference: during re-render
 * storms, tracked references go stale while live rows keep the class. Instead, every
 * `mouseover` (and each render/leave/blur/scroll) sweeps the class off the live DOM and
 * then marks only the row/header currently under the cursor. */

/**
 * Create a hover manager for a list container.
 *
 * @param {Object} config
 * @param {string} config.containerSelector  CSS selector for the scrollable list container
 * @param {string} config.rowHoverClass      Class toggled on the hovered row (e.g. "n-row--hover")
 * @param {string} [config.headerHoverClass] Optional class for repo headers
 * @param {string} [config.rowSelector]      CSS selector for rows (default: ".n-row")
 * @param {string} [config.headerSelector]   CSS selector for headers (default: ".repo-header")
 * @returns {{ clear: () => void, wire: () => void }}
 */
export function createHoverManager({
  containerSelector,
  rowHoverClass,
  headerHoverClass,
  rowSelector = ".n-row",
  headerSelector = ".repo-header",
}) {
  function clear() {
    const container = $(containerSelector);
    if (!container) return;
    for (const el of container.querySelectorAll(`.${rowHoverClass}`)) {
      el.classList.remove(rowHoverClass);
    }
    if (headerHoverClass) {
      for (const el of container.querySelectorAll(`.${headerHoverClass}`)) {
        el.classList.remove(headerHoverClass);
      }
    }
  }

  function set(row, header) {
    clear();
    row?.classList.add(rowHoverClass);
    if (headerHoverClass) header?.classList.add(headerHoverClass);
  }

  function wire() {
    const container = $(containerSelector);
    if (!container) return;
    container.addEventListener("mouseover", (e) => {
      const el = e.target instanceof Element ? e.target : (e.target?.parentElement ?? null);
      set(
        el?.closest(rowSelector) ?? null,
        headerHoverClass ? (el?.closest(headerSelector) ?? null) : null,
      );
    });
    container.addEventListener("mouseleave", clear);
    container.addEventListener("scroll", clear, { passive: true });
    window.addEventListener("blur", clear);
  }

  return { clear, wire };
}

/* ──────────────────────────── Kbd-focus ring ───────────────────────────────
 *
 * Manages the keyboard-selection ring marker on rows. The ring shows for
 * programmatic/keyboard focus (mouse clicks use `:focus-visible`, which stays clean);
 * it's cleared on the next mouse interaction. */

/**
 * Create a kbd-focus ring manager.
 *
 * @param {Object} config
 * @param {string} config.containerSelector  CSS selector for the list container
 * @param {string} [config.focusClass]       Class name for the ring (default: "kbd-focus")
 * @returns {{ clear: () => void, apply: (el: Element) => void, wire: () => void }}
 */
export function createKbdFocusRing({ containerSelector, focusClass = "kbd-focus" }) {
  function clear() {
    const container = $(containerSelector);
    if (!container) return;
    for (const el of container.querySelectorAll(`.${focusClass}`)) {
      el.classList.remove(focusClass);
    }
  }

  function apply(el) {
    clear();
    el?.classList.add(focusClass);
  }

  function wire() {
    const container = $(containerSelector);
    if (!container) return;
    container.addEventListener("mousedown", clear);
  }

  return { clear, apply, wire };
}

/* ──────────────────────── Keyboard row navigation ─────────────────────────
 *
 * j/k (and arrow keys) move the keyboard cursor through the item rows. From outside
 * the list, j/↓ enters at the first row, k/↑ at the last. */

/**
 * Create a keyboard row navigator.
 *
 * @param {Object} config
 * @param {string}   config.containerSelector  CSS selector for the list container
 * @param {string}   config.rowSelector        CSS selector for item rows (e.g. ".n-row")
 * @param {Function} config.focusRow           `(row: Element, kbd: boolean) => void` — focus a row
 * @returns {{ rows: () => Element[], activeRow: () => Element|null, moveActiveRow: (delta: number) => void }}
 */
export function createRowNavigator({ containerSelector, rowSelector, focusRow }) {
  function rows() {
    const container = $(containerSelector);
    return container ? [...container.querySelectorAll(rowSelector)] : [];
  }

  function activeRow() {
    const el = document.activeElement;
    return el instanceof HTMLElement ? el.closest(`${containerSelector} ${rowSelector}`) : null;
  }

  function moveActiveRow(delta) {
    const all = rows();
    if (!all.length) return;
    const current = activeRow();
    const at = current ? all.indexOf(current) : -1;
    const next =
      at === -1
        ? delta > 0
          ? 0
          : all.length - 1
        : Math.min(all.length - 1, Math.max(0, at + delta));
    focusRow(all[next], true);
  }

  return { rows, activeRow, moveActiveRow };
}

/* ───────────────────────── Focus capture + restore ──────────────────────────
 *
 * Captures which row/control currently owns focus in a list container, then restores that
 * focus target after a wholesale re-render. Each caller owns how targets are encoded and how
 * rows/controls are matched; this helper only centralizes the container/focus plumbing. */

/**
 * Create a list focus retainer.
 *
 * @param {Object} config
 * @param {string} config.containerSelector
 * @param {string} config.rowSelector
 * @param {Function} config.captureTarget `(row: Element, active: Element) => any`
 * @param {Function} config.matchRow      `(row: Element, target: any) => boolean`
 * @param {Function} config.resolveElement `(row: Element, target: any) => Element|null`
 * @returns {{ capture: () => any, apply: (target: any, options?: { preventScroll?: boolean }) => boolean }}
 */
export function createListFocusRetainer({
  containerSelector,
  rowSelector,
  captureTarget,
  matchRow,
  resolveElement,
}) {
  function capture() {
    const active = document.activeElement;
    const container = $(containerSelector);
    if (!active || !container || !container.contains(active)) return null;
    const row = active.closest(rowSelector);
    if (!row) return null;
    return captureTarget(row, active);
  }

  function apply(target, { preventScroll = false } = {}) {
    if (!target) return false;
    const container = $(containerSelector);
    if (!container) return false;
    const row = [...container.querySelectorAll(rowSelector)].find((candidate) =>
      matchRow(candidate, target),
    );
    if (!row) return false;
    const el = resolveElement(row, target);
    if (!el) return false;
    el.focus({ preventScroll });
    return true;
  }

  return { capture, apply };
}
