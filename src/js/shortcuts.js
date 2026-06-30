import { listen } from "./api.js";
import { html, rawHtml } from "./dom.js";

/* The keyboard-shortcuts cheatsheet: a single in-app overlay opened by `?` or the macOS
 * "Keyboard Shortcuts" menu item (which emits `menu:shortcuts`). The SHORTCUTS registry
 * below is the single source of truth for what the overlay shows; the actual key handling
 * for the inbox-scoped commands lives in inbox.js. */

/** Grouped shortcut reference. `keys` are rendered as individual <kbd> chips. */
const SHORTCUTS = [
  {
    group: "Navigation",
    items: [
      { keys: ["j", "↓"], desc: "Next notification" },
      { keys: ["k", "↑"], desc: "Previous notification" },
      { keys: ["Enter"], desc: "Open in browser" },
    ],
  },
  {
    group: "Triage",
    items: [
      { keys: ["d", "e"], desc: "Mark as done" },
      { keys: ["c"], desc: "Copy link" },
      { keys: ["b"], desc: "Bookmark / unbookmark" },
      { keys: ["r"], desc: "Sync now" },
    ],
  },
  {
    group: "Filters",
    items: [
      { keys: ["1"], desc: "Switch smart filter (1 = All … 7 = Bookmarks)" },
    ],
  },
  {
    group: "General",
    items: [
      { keys: ["⌘", "1"], desc: "Notifications module" },
      { keys: ["⌘", "2"], desc: "Dependabot module" },
      { keys: ["⌘", ","], desc: "Open Settings" },
      { keys: ["?"], desc: "Show this cheatsheet" },
      { keys: ["Esc"], desc: "Close menu / overlay" },
    ],
  },
];

/** Render the cheatsheet body (pure). Each shortcut row pairs its <kbd> chips with a
 *  description; groups become labelled sections. */
export function renderShortcuts(groups) {
  return groups
    .map((g) => {
      const items = g.items
        .map((it) => {
          const keys = it.keys.map((k) => html`<kbd>${k}</kbd>`).join(" ");
          return html`
            <div class="shortcuts-row">
              <dt class="shortcuts-keys">${rawHtml(keys)}</dt>
              <dd class="shortcuts-desc">${it.desc}</dd>
            </div>`;
        })
        .join("");
      return html`
      <section class="shortcuts-group">
        <h3 class="shortcuts-group-title">${g.group}</h3>
        <dl class="shortcuts-list">${rawHtml(items)}</dl>
      </section>`;
    })
    .join("");
}

/** The currently-open overlay element, or null. */
let overlay = null;
/** Element focus is returned to when the overlay closes. */
let returnFocus = null;

export function isShortcutsOpen() {
  return overlay != null;
}

export function openShortcuts() {
  if (overlay) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "shortcuts-title");
  overlay.innerHTML = html`
    <div class="shortcuts-panel" role="document">
      <div class="shortcuts-head">
        <h2 class="shortcuts-title" id="shortcuts-title">Keyboard shortcuts</h2>
        <button type="button" class="icon-btn shortcuts-close" aria-label="Close">
          ${rawHtml('<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>')}
        </button>
      </div>
      <div class="shortcuts-grid">${rawHtml(renderShortcuts(SHORTCUTS))}</div>
    </div>`;

  // Backdrop click (outside the panel) closes; clicks inside don't bubble out to close.
  // Normalize text-node targets so `.closest` is always called on an Element.
  overlay.addEventListener("mousedown", (e) => {
    const el = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (!el?.closest(".shortcuts-panel")) closeShortcuts();
  });
  overlay.querySelector(".shortcuts-close").addEventListener("click", closeShortcuts);

  document.body.appendChild(overlay);
  // Move focus into the dialog so Esc/Tab act on it and screen readers announce it.
  overlay.querySelector(".shortcuts-close")?.focus();
}

export function closeShortcuts() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  returnFocus?.focus?.();
  returnFocus = null;
}

export function toggleShortcuts() {
  if (overlay) closeShortcuts();
  else openShortcuts();
}

/** Wire the global `?` toggle, Esc-to-close, a focus trap, and the menu event. */
export function initShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Don't hijack typing in form fields.
    const t = e.target;
    const typing =
      t instanceof HTMLElement &&
      (t.matches("input, textarea, select") || t.isContentEditable);

    if (overlay) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeShortcuts();
      } else if (e.key === "Tab") {
        // Only the close button is focusable inside; keep focus trapped on it.
        e.preventDefault();
        overlay.querySelector(".shortcuts-close")?.focus();
      } else if (e.key === "?") {
        // A second `?` closes, matching the toggle.
        e.preventDefault();
        closeShortcuts();
      }
      return;
    }

    if (!typing && e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openShortcuts();
    }
  });

  // The macOS "Keyboard Shortcuts" menu item routes here via a backend event.
  listen("menu:shortcuts", () => toggleShortcuts());
}
