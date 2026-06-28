import { html, rawHtml } from "./dom.js";

/* Small presentational render helpers shared across the generated views. They keep the
 * repeated markup (label pills, icon-only buttons, sidebar source entries) in one place
 * with the accessibility defaults baked in — notably: every text field is HTML-escaped
 * here, so callers can't forget. `icon` arguments are trusted inline-SVG strings owned by
 * the app, never user data. */

/** An inline label pill — `<span class="{className}">…</span>` with the text escaped.
 *  Used for the subject/state badges and the private-repo lock badge. */
export function pill(text, className, { title = "" } = {}) {
  const titleAttr = title ? html` title="${title}"` : "";
  return html`<span class="${className}"${rawHtml(titleAttr)}>${text}</span>`;
}

/** An icon-only button with the a11y essentials baked in: an explicit `type`, an
 *  `aria-label` (icons have no text), and a `title` tooltip defaulting to that label.
 *  `attrs` is a pre-built (trusted) attribute string for extras (ids, data-*). */
export function iconButton({ icon, label, className = "icon-btn", title, attrs = "" }) {
  const tooltip = title ?? label;
  const extraAttrs = attrs ? rawHtml(` ${attrs}`) : "";
  return html`<button type="button" class="${className}" title="${tooltip}" aria-label="${label}"${extraAttrs}>${rawHtml(icon)}</button>`;
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
  const current = active ? rawHtml(` aria-current="true"`) : "";
  const titleAttr = labelTitle ? html` title="${labelTitle}"` : "";
  const lockSuffix = lock ? " 🔒" : "";
  const countHtml =
    count !== "" || countKey
      ? html`<span class="source-count"${countKey ? rawHtml(html` data-count="${countKey}"`) : ""}>${count}</span>`
      : "";
  return html`<li>
    <button type="button" class="${cls}"${attrs ? rawHtml(` ${attrs}`) : ""}${current}>
      <span class="source-icon" aria-hidden="true">${rawHtml(icon)}</span>
      <span class="source-label"${rawHtml(titleAttr)}>${label}${lockSuffix}</span>
      ${rawHtml(countHtml)}
    </button>
  </li>`;
}
