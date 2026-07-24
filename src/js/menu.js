/* The single popover/context-menu primitive: a small macOS-style menu used for the
   right-click row actions and the toolbar ••• confirm flows. Single-instance — opening a
   new one replaces any current one. Items may nest one level deep (`submenu`), which is how
   the row menu offers the snooze durations. Callers use `openContextMenu` / `closeMenu`, and
   the global dismissal wiring in main.js uses `isMenuOpen` / `menuContains`.

   The focus handling here is deliberately careful — see `onMenuFocusOut` for the macOS
   WKWebView mousedown-blur gotcha that made menu clicks silently no-op (PR #59). */

import { $ } from "./dom.js";

/** The open popover menu element, if any (single-instance; closed on any outside action). */
let openMenu = null;
/** The open child popover, if any, and the parent item it hangs off. Only one level deep. */
let openSubmenu = null;
let openSubmenuParent = null;
/** The element that had focus before the menu opened, so focus can return there on close
 *  (otherwise removing the focused menu item dumps focus to <body>). */
let menuReturnFocus = null;

/** Whether a menu is currently open. */
export function isMenuOpen() {
  return openMenu != null;
}

/** Whether `node` is inside the open menu — including its submenu, which is a sibling
 *  popover in the DOM rather than a descendant (used by the outside-click dismissal). */
export function menuContains(node) {
  if (openMenu != null && openMenu.contains(node)) return true;
  return openSubmenu != null && openSubmenu.contains(node);
}

/** Close the open submenu, optionally returning focus to the parent item. */
function closeSubmenu(restoreFocus = false) {
  if (!openSubmenu) return;
  const sub = openSubmenu;
  const parent = openSubmenuParent;
  // Clear the handles first: detaching a focused item blurs it synchronously, which would
  // otherwise re-enter the focusout handler mid-teardown.
  openSubmenu = null;
  openSubmenuParent = null;
  sub.removeEventListener("focusout", onMenuFocusOut);
  sub.remove();
  parent?.setAttribute("aria-expanded", "false");
  if (restoreFocus && parent && document.contains(parent)) parent.focus();
}

/** Close the open menu. By default returns focus to wherever it was before the menu opened;
 *  pass `restoreFocus = false` when immediately reopening, to avoid a focus flicker. */
export function closeMenu(restoreFocus = true) {
  if (!openMenu) return;
  const menu = openMenu;
  // Clear the handle first so the focusout fired while detaching the menu is a no-op
  // (removing a focused element blurs it synchronously, which would re-enter here).
  openMenu = null;
  closeSubmenu();
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
    // Escape backs out one level at a time: the submenu first, then the whole menu.
    if (openSubmenu) closeSubmenu(true);
    else closeMenu();
    return;
  }
  if (!openMenu) return;
  // Arrow keys act on whichever popover currently holds focus.
  const surface = openSubmenu ?? openMenu;
  const items = [...surface.querySelectorAll(".context-menu-item:not(:disabled)")];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  // ARIA submenu semantics: Right opens/enters a submenu, Left leaves it.
  if (e.key === "ArrowRight" && !openSubmenu) {
    if (items[idx]?.dataset.submenu === "true") {
      e.preventDefault();
      openSubmenuFor(items[idx], true);
    }
    return;
  }
  if (e.key === "ArrowLeft" && openSubmenu) {
    e.preventDefault();
    closeSubmenu(true);
    return;
  }
  let next = null;
  if (e.key === "ArrowDown") next = items[idx < 0 ? 0 : (idx + 1) % items.length];
  else if (e.key === "ArrowUp") next = items[idx <= 0 ? items.length - 1 : idx - 1];
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
  if (menuContains(to)) return; // moved between items / into the submenu — keep open
  // Focus moving to the mark-all trigger means the user clicked it to toggle the menu
  // closed; let that click handler do it, so we don't close-then-immediately-reopen.
  if (to.closest?.("#mark-all-done-btn")) return;
  closeMenu(false);
  // Focus has already left for good, so drop the pre-menu focus reference rather than
  // holding a stale node until the next menu opens.
  menuReturnFocus = null;
}

/** Build a popover element for `items` ({ label, danger?, disabled?, separator?, submenu?,
 *  action }). An item carrying a `submenu` array opens a nested popover instead of acting. */
function buildMenu(items, nested = false) {
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
    const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
    const btn = document.createElement("button");
    btn.type = "button";
    const parentClass = hasSubmenu ? " context-menu-item--parent" : "";
    btn.className = `context-menu-item${item.danger ? " context-menu-item--danger" : ""}${parentClass}`;
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    if (hasSubmenu) {
      btn.dataset.submenu = "true";
      btn.setAttribute("aria-haspopup", "menu");
      btn.setAttribute("aria-expanded", "false");
      const chevron = document.createElement("span");
      chevron.className = "context-menu-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "›";
      btn.appendChild(chevron);
      submenuItems.set(btn, item.submenu);
    }
    if (item.disabled) {
      btn.disabled = true;
    } else if (hasSubmenu) {
      btn.addEventListener("click", () => openSubmenuFor(btn, true));
      btn.addEventListener("mouseenter", () => openSubmenuFor(btn, false));
    } else {
      btn.addEventListener("click", () => {
        closeMenu();
        item.action();
      });
      // Moving onto a sibling item in the *root* menu dismisses an open submenu, as in a
      // native menu. Items inside the submenu itself must not (that would close the popover
      // the pointer is heading into).
      if (!nested) {
        btn.addEventListener("mouseenter", () => {
          if (openSubmenu && openSubmenuParent !== btn) closeSubmenu();
        });
      }
    }
    menu.appendChild(btn);
  }
  return menu;
}

/** Submenu payloads keyed by their parent item element (a WeakMap so detached menus are
 *  collected with their items). */
const submenuItems = new WeakMap();

/** Place `menu` at the given viewport point, clamped to stay on-screen. */
function placeMenu(menu, x, y) {
  // Place off-screen first to measure, then clamp into the viewport.
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

/** Open (or re-focus) the child popover for a submenu parent item, flipping to the item's
 *  left when there isn't room on the right. */
function openSubmenuFor(parentBtn, focusFirst) {
  if (openSubmenuParent === parentBtn) {
    if (focusFirst) openSubmenu?.querySelector(".context-menu-item:not(:disabled)")?.focus();
    return;
  }
  closeSubmenu();
  const items = submenuItems.get(parentBtn);
  if (!items) return;
  const sub = buildMenu(items, true);
  const rect = parentBtn.getBoundingClientRect();
  // Nudge up by the popover's own padding so the first child item lines up with its parent.
  placeMenu(sub, rect.right - 2, rect.top - 6);
  const subWidth = sub.getBoundingClientRect().width;
  if (rect.right - 2 + subWidth > window.innerWidth - 8) {
    sub.style.left = `${Math.max(8, rect.left - subWidth + 2)}px`;
  }
  sub.addEventListener("focusout", onMenuFocusOut);
  openSubmenu = sub;
  openSubmenuParent = parentBtn;
  parentBtn.setAttribute("aria-expanded", "true");
  if (focusFirst) sub.querySelector(".context-menu-item:not(:disabled)")?.focus();
}

/** Open a popover menu of `items` ({ label, danger?, disabled?, separator?, submenu?, action })
 *  anchored at the given viewport point, clamped to stay on-screen. */
export function openContextMenu(x, y, items) {
  // Capture the pre-menu focus target before we move focus into the popover. When a menu
  // is already open (reopening), keep the original target and close without restoring it,
  // so focus lands directly in the new menu rather than flickering back to the trigger.
  const reopening = openMenu != null;
  const previouslyFocused = document.activeElement;
  closeMenu(false);
  if (!reopening) {
    menuReturnFocus = previouslyFocused instanceof HTMLElement ? previouslyFocused : null;
  }
  const menu = buildMenu(items);
  placeMenu(menu, x, y);
  openMenu = menu;
  document.addEventListener("keydown", onMenuKeydown, true);
  // Close if focus leaves the popover entirely (Tab is trapped, but AT or programmatic
  // moves can still pull focus out).
  menu.addEventListener("focusout", onMenuFocusOut);
  // Move focus into the menu so keyboard users land in the popover (the trigger, e.g. the
  // ••• button, otherwise keeps focus and Tab never reaches it). Escape closes the menu.
  menu.querySelector(".context-menu-item:not(:disabled)")?.focus();
}
