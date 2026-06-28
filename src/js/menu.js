/* The single popover/context-menu primitive: a small macOS-style menu used for the
   right-click row actions and the toolbar ••• confirm flows. Single-instance — opening a
   new one replaces any current one. Callers use `openContextMenu` / `closeMenu`, and the
   global dismissal wiring in main.js uses `isMenuOpen` / `menuContains`.

   The focus handling here is deliberately careful — see `onMenuFocusOut` for the macOS
   WKWebView mousedown-blur gotcha that made menu clicks silently no-op (PR #59). */

import { $ } from "./dom.js";

/** The open popover menu element, if any (single-instance; closed on any outside action). */
let openMenu = null;
/** The element that had focus before the menu opened, so focus can return there on close
 *  (otherwise removing the focused menu item dumps focus to <body>). */
let menuReturnFocus = null;

/** Whether a menu is currently open. */
export function isMenuOpen() {
  return openMenu != null;
}

/** Whether `node` is inside the open menu (used by the outside-click dismissal). */
export function menuContains(node) {
  return openMenu != null && openMenu.contains(node);
}

/** Close the open menu. By default returns focus to wherever it was before the menu opened;
 *  pass `restoreFocus = false` when immediately reopening, to avoid a focus flicker. */
export function closeMenu(restoreFocus = true) {
  if (!openMenu) return;
  const menu = openMenu;
  // Clear the handle first so the focusout fired while detaching the menu is a no-op
  // (removing a focused element blurs it synchronously, which would re-enter here).
  openMenu = null;
  menu.removeEventListener("focusout", onMenuFocusOut);
  menu.remove();
  document.removeEventListener("keydown", onMenuKeydown, true);
  // Reflect the collapsed state on the toolbar trigger for assistive tech.
  $("#mark-all-done-btn")?.setAttribute("aria-expanded", "false");
  const target = menuReturnFocus;
  if (restoreFocus) {
    menuReturnFocus = null;
    if (target && document.contains(target)) target.focus();
  }
}

function onMenuKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeMenu();
    return;
  }
  if (!openMenu) return;
  // ARIA menu semantics: arrow keys (and Home/End) move between enabled items.
  const items = [...openMenu.querySelectorAll(".context-menu-item:not(:disabled)")];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === "ArrowDown") next = items[idx < 0 ? 0 : (idx + 1) % items.length];
  else if (e.key === "ArrowUp")
    next = items[idx <= 0 ? items.length - 1 : idx - 1];
  else if (e.key === "Home") next = items[0];
  else if (e.key === "End") next = items[items.length - 1];
  else if (e.key === "Tab") {
    // Trap Tab within the popover (wrapping at the ends) so keyboard focus can't escape to
    // the page behind it; Escape / outside-click / an item activation are the ways out.
    e.preventDefault();
    const step = e.shiftKey ? -1 : 1;
    next = items[(idx < 0 ? 0 : idx + step + items.length) % items.length];
  }
  if (next) {
    e.preventDefault();
    next.focus();
  }
}

/** Close the menu when focus genuinely moves to another element outside it (e.g. VoiceOver
 *  navigating to a different control). Deliberately ignores a null `relatedTarget`: on macOS
 *  WKWebView a <button> blurs to <body> on **mousedown** — firing `focusout` BEFORE its
 *  `click` — so closing on that would remove the item and swallow the click (the action
 *  would never run). Plain outside clicks are dismissed by the document `mousedown` listener,
 *  and Escape / scroll / window-blur also close the menu. */
function onMenuFocusOut(e) {
  if (!openMenu) return;
  const to = e.relatedTarget;
  if (!to) return; // focus fell to <body> (incl. the WKWebView mousedown blur) — keep open
  if (openMenu.contains(to)) return; // moved between items (arrow keys / Tab trap) — keep open
  // Focus moving to the mark-all trigger means the user clicked it to toggle the menu
  // closed; let that click handler do it, so we don't close-then-immediately-reopen.
  if (to.closest?.("#mark-all-done-btn")) return;
  closeMenu(false);
  // Focus has already left for good, so drop the pre-menu focus reference rather than
  // holding a stale node until the next menu opens.
  menuReturnFocus = null;
}

/** Open a popover menu of `items` ({ label, danger?, disabled?, separator?, action }) anchored
 *  at the given viewport point, clamped to stay on-screen. */
export function openContextMenu(x, y, items) {
  // Capture the pre-menu focus target before we move focus into the popover. When a menu
  // is already open (reopening), keep the original target and close without restoring it,
  // so focus lands directly in the new menu rather than flickering back to the trigger.
  const reopening = openMenu != null;
  const previouslyFocused = document.activeElement;
  closeMenu(false);
  if (!reopening) {
    menuReturnFocus =
      previouslyFocused instanceof HTMLElement ? previouslyFocused : null;
  }
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      // Expose the divider to assistive tech rather than as an unlabeled element in the menu.
      sep.setAttribute("role", "separator");
      sep.setAttribute("aria-orientation", "horizontal");
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `context-menu-item${item.danger ? " context-menu-item--danger" : ""}`;
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    if (item.disabled) {
      btn.disabled = true;
    } else {
      btn.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
    }
    menu.appendChild(btn);
  }
  // Place off-screen first to measure, then clamp into the viewport.
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  document.addEventListener("keydown", onMenuKeydown, true);
  // Close if focus leaves the popover entirely (Tab is trapped, but AT or programmatic
  // moves can still pull focus out).
  menu.addEventListener("focusout", onMenuFocusOut);
  // Move focus into the menu so keyboard users land in the popover (the trigger, e.g. the
  // ••• button, otherwise keeps focus and Tab never reaches it). Escape closes the menu.
  menu.querySelector(".context-menu-item:not(:disabled)")?.focus();
}
