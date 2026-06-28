/* Settings → Local storage pane: shows the SQLite database path, schema version, and
   table list, with reveal-in-Finder and copy-path affordances. */

import { invoke } from "./api.js";
import { $, escapeHtml, flash, copyText } from "./dom.js";
import { iconButton } from "./ui.js";

/** Folder icon for the reveal-in-Finder affordance. */
const REVEAL_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.75 5.25V4c0-.7.55-1.25 1.25-1.25h2.8c.33 0 .65.13.88.37l.99.96H13c.7 0 1.25.55 1.25 1.25v6c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;

/** Populate the Local storage settings group from `db_status`, wiring the reveal/copy
 *  controls. On error, renders an inline message instead. */
export async function loadStorage() {
  try {
    const status = await invoke("db_status");
    const tables = status.tables.length
      ? status.tables.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join("")
      : "<li><em>no tables</em></li>";
    $("#storage-body").innerHTML = `
      <div class="srow">
        <span class="srow-label">Database</span>
        <span class="srow-value">
          <span class="dbpath" id="db-path" role="button" tabindex="0"
          title="Copy database path" aria-label="Copy database path">${escapeHtml(status.path)}</span>
          <span class="srow-flash" id="db-copy-flash" role="status" aria-live="polite">Copied</span>
          ${iconButton({
            icon: REVEAL_ICON,
            label: "Reveal in Finder",
            attrs: 'id="reveal-db"',
          })}
        </span>
      </div>
      <div class="srow">
        <span class="srow-label">Schema version</span>
        <span class="srow-value">v${escapeHtml(status.schema_version)}</span>
      </div>
      <div class="srow">
        <span class="srow-label">Tables</span>
        <span class="srow-value"><ul class="tables">${tables}</ul></span>
      </div>`;

    const path = status.path;
    $("#reveal-db").addEventListener("click", () => {
      invoke("reveal_in_finder", { path }).catch((err) => {
        console.error(err);
        flash($("#db-copy-flash"), "Reveal failed", "error");
      });
    });
    const copyPath = async () => {
      if (await copyText(path)) {
        flash($("#db-copy-flash"), "Copied");
      } else {
        flash($("#db-copy-flash"), "Copy failed", "error");
      }
    };
    const dbPathEl = $("#db-path");
    dbPathEl.addEventListener("click", copyPath);
    // Keyboard support for the button-role path (Enter / Space activate copy).
    dbPathEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        copyPath();
      }
    });
  } catch (err) {
    $("#storage-body").innerHTML = `
      <div class="srow">
        <p class="error-text">Could not open the local database.</p>
      </div>
      <div class="srow">
        <pre class="error-detail">${escapeHtml(err)}</pre>
      </div>`;
  }
}
