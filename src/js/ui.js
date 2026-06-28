import { escapeHtml } from "./dom.js";

/* Small presentational render helpers shared across the generated views. They keep the
 * repeated markup (label pills, icon-only buttons, sidebar source entries) in one place
 * with the accessibility defaults baked in — notably: every text field is HTML-escaped
 * here, so callers can't forget. `icon` arguments are trusted inline-SVG strings owned by
 * the app, never user data. */

/** An inline label pill — `<span class="{className}">…</span>` with the text escaped.
 *  Used for the subject/state badges and the private-repo lock badge. */
export function pill(text, className, { title = "" } = {}) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<span class="${escapeHtml(className)}"${titleAttr}>${escapeHtml(text)}</span>`;
}

/** An icon-only button with the a11y essentials baked in: an explicit `type`, an
 *  `aria-label` (icons have no text), and a `title` tooltip defaulting to that label.
 *  `attrs` is a pre-built (trusted) attribute string for extras (ids, data-*). */
export function iconButton({ icon, label, className = "icon-btn", title, attrs = "" }) {
  const tooltip = title ?? label;
  return (
    `<button type="button" class="${escapeHtml(className)}" title="${escapeHtml(tooltip)}"` +
    ` aria-label="${escapeHtml(label)}"${attrs ? ` ${attrs}` : ""}>${icon}</button>`
  );
}

/** A sidebar "source" entry (a smart filter or a repository) as an `<li><button>`: the
 *  shared icon + label (+ optional count) skeleton, with the active selection exposed to
 *  assistive tech via `aria-current`. `count` is the count badge's inner text ("" for
 *  none); `countKey` adds the `data-count` hook the live count-updater keys on. `lock`
 *  appends the private-repo marker to the label. */
export function sourceButton({
  icon,
  label,
  labelTitle = "",
  lock = false,
  className = "",
  attrs = "",
  active = false,
  count = "",
  countKey = "",
}) {
  const cls = `source${className ? ` ${className}` : ""}${active ? " source--active" : ""}`;
  const current = active ? ` aria-current="true"` : "";
  const titleAttr = labelTitle ? ` title="${escapeHtml(labelTitle)}"` : "";
  const lockSuffix = lock ? " 🔒" : "";
  const countHtml =
    count !== "" || countKey
      ? `<span class="source-count"${countKey ? ` data-count="${escapeHtml(countKey)}"` : ""}>${escapeHtml(count)}</span>`
      : "";
  return `<li>
      <button type="button" class="${escapeHtml(cls)}"${attrs ? ` ${attrs}` : ""}${current}>
        <span class="source-icon" aria-hidden="true">${icon}</span>
        <span class="source-label"${titleAttr}>${escapeHtml(label)}${lockSuffix}</span>
        ${countHtml}
      </button>
    </li>`;
}
