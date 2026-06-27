/* Small DOM helpers and transient user feedback (flash, toast, screen-reader announce).
   Pure presentation utilities with no app state — the "view toolbox" the rest of the UI
   builds on. They touch `document` only when called, so the module itself is importable in
   a non-DOM context (e.g. unit tests for `escapeHtml`). */

import { FLASH_DISMISS_MS, TOAST_DISMISS_MS } from "./constants.js";

/** `querySelector` / `querySelectorAll` shorthands. */
export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

/** Escape a value for safe interpolation into an HTML string. */
export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/** Briefly show a transient confirmation in `el` (e.g. "Saved", "Copied"), then fade it
 *  out. Reuses the `.srow-flash` styling. Pass `kind = "error"` for a red message. */
export function flash(el, text, kind) {
  if (!el) return;
  if (text != null) el.textContent = text;
  el.classList.toggle("srow-flash--error", kind === "error");
  el.classList.add("srow-flash--show");
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => {
    el.classList.remove("srow-flash--show");
  }, FLASH_DISMISS_MS);
}

let toastTimer = null;

/** Show a brief, self-dismissing toast for actions with no inline anchor (e.g. a copy
 *  triggered from the right-click menu). Announced politely for screen readers. */
export function toast(text, kind) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.toggle("toast--error", kind === "error");
  // Restart the CSS transition even if a toast is already showing.
  el.classList.remove("toast--show");
  void el.offsetWidth;
  el.classList.add("toast--show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("toast--show"), TOAST_DISMISS_MS);
}

/** Announce a concise message to assistive tech via the visually-hidden live region.
 *  The inbox is not itself a live region (it re-renders wholesale), so user-meaningful
 *  transitions — filter changes, mark-done outcomes — are surfaced here instead. Re-sets
 *  identical text by clearing first so repeated messages still announce. */
export function announce(text) {
  const el = $("#a11y-announcer");
  if (!el) return;
  el.textContent = "";
  // Re-set on the next frame: clearing then setting on a separate frame re-triggers the
  // live region even when the text is identical to the previous announcement.
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

/** Copy `text` to the clipboard, returning whether it succeeded. Tries the async Clipboard
 *  API first, then falls back to a hidden-textarea `execCommand("copy")` — the async API is
 *  unavailable/blocked in the macOS WKWebView Tauri uses, so the fallback is what actually
 *  runs there. */
export async function copyText(text) {
  text = String(text);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path below.
  }
  // Selecting the textarea steals focus; restore it afterwards so keyboard/AT users aren't
  // dropped to <body> (the async Clipboard path doesn't move focus).
  const prevFocus = document.activeElement;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Keep it out of view and inert, but selectable so `execCommand("copy")` has a target.
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    try {
      ta.select();
      ta.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } finally {
      ta.remove();
      if (prevFocus instanceof HTMLElement) prevFocus.focus();
    }
  } catch {
    return false;
  }
}
