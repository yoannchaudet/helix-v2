/* Draggable sidebar width. The CSS `--sidebar-w` default is treated as the minimum; the
   chosen width is persisted across launches in localStorage. Self-contained — call
   `initSidebarResize()` once after the DOM is ready. */

import { $ } from "./dom.js";
import {
  SIDEBAR_MIN_FALLBACK_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_KEY_STEP_PX,
} from "./constants.js";

export function initSidebarResize() {
  const resizer = $("#sidebar-resizer");
  if (!resizer) return;

  const root = document.documentElement;
  const min =
    parseInt(getComputedStyle(root).getPropertyValue("--sidebar-w"), 10) ||
    SIDEBAR_MIN_FALLBACK_PX;
  const max = SIDEBAR_MAX_PX;
  const STEP = SIDEBAR_KEY_STEP_PX;
  let current = min;

  // Single entry point for width changes: clamp, apply, expose to AT, and persist.
  const setWidth = (w, persist = true) => {
    current = Math.max(min, Math.min(max, Math.round(w)));
    root.style.setProperty("--sidebar-w", `${current}px`);
    resizer.setAttribute("aria-valuenow", String(current));
    if (persist) localStorage.setItem("helix:sidebar-w", String(current));
  };

  resizer.setAttribute("aria-valuemin", String(min));
  resizer.setAttribute("aria-valuemax", String(max));

  const saved = Number.parseInt(localStorage.getItem("helix:sidebar-w"), 10);
  setWidth(Number.isFinite(saved) ? saved : min, false);

  let dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    // The sidebar starts at the window's left edge, so its width === cursor X.
    setWidth(e.clientX, false);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove("sidebar-resizer--dragging");
    document.body.style.cursor = "";
    localStorage.setItem("helix:sidebar-w", String(current));
  };

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't start a text/window-drag interaction
    dragging = true;
    resizer.classList.add("sidebar-resizer--dragging");
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  // A mouseup outside the webview is never delivered; terminate on blur so the
  // drag can't get stuck (cursor left as col-resize).
  window.addEventListener("blur", onUp);

  // Keyboard operability for the separator (arrows step, Home/End jump).
  resizer.addEventListener("keydown", (e) => {
    let next = current;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = current - STEP;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = current + STEP;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    setWidth(next);
  });

  // Double-click resets to the default (minimum) width.
  resizer.addEventListener("dblclick", () => setWidth(min));
}
