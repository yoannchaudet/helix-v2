const { invoke } = window.__TAURI__.core;

const dot = () => document.querySelector("#status-dot");
const label = () => document.querySelector("#status-label");
const body = () => document.querySelector("#storage-body");

/** Swap the color-coded state classes on the dot + label (green/yellow/red). */
function setState(state, text) {
  for (const el of [dot(), label()]) {
    el.classList.remove(
      "status-dot--pending",
      "status-dot--success",
      "status-dot--error",
      "status-label--pending",
      "status-label--success",
      "status-label--error",
    );
  }
  dot().classList.add(`status-dot--${state}`);
  label().classList.add(`status-label--${state}`);
  label().textContent = text;
}

function renderReady(status) {
  setState("success", "Ready");
  const tables = status.tables.length
    ? status.tables.map((t) => `<li><code>${t}</code></li>`).join("")
    : "<li><em>no tables</em></li>";

  body().innerHTML = `
    <dl class="kv">
      <dt>Database</dt>
      <dd><code>${status.path}</code></dd>
      <dt>Schema version</dt>
      <dd>v${status.schema_version}</dd>
      <dt>Tables</dt>
      <dd><ul class="tables">${tables}</ul></dd>
    </dl>
  `;
}

function renderError(message) {
  setState("error", "Error");
  body().innerHTML = `
    <p class="error-text">Could not open the local database.</p>
    <pre class="error-detail">${message}</pre>
  `;
}

async function init() {
  setState("pending", "Bootstrapping…");
  try {
    const status = await invoke("db_status");
    renderReady(status);
  } catch (err) {
    renderError(String(err));
  }
}

window.addEventListener("DOMContentLoaded", init);
