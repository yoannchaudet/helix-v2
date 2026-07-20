import { invoke } from "./api.js";
import { $, html, rawHtml, toast } from "./dom.js";
import { openContextMenu } from "./menu.js";
import { registerModule } from "./modules.js";
import { sourceButton } from "./ui.js";
import { isAuthenticated } from "./account.js";
import { relTime } from "./format.js";
import {
  groupDipsByRepo,
  summarize,
  formatPercent,
  dipStatus,
  avatarUrl,
  repoDomId,
  countDipsByRepoId,
} from "./slo-dips-model.js";

const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const ALL_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8l1.6 1.7L10.6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const STALE_CATEGORIES_CODE = "SLO_DIPS_STALE_CATEGORIES:";

let repositories = [];
let dips = [];
let dipsLoaded = false;
let dipsError = "";
let refreshing = false;
let autoRefreshed = false;
let activeRepoId = null;
let filterRepoId = null;
let editor = { mode: "idle" };
let requestSequence = 0;

function errorText(error) {
  return String(error)
    .replace(/^Error:\s*/, "")
    .replace(`${STALE_CATEGORIES_CODE} `, "");
}

function activeRepository() {
  return repositories.find((repository) => repository.id === activeRepoId) ?? null;
}

function selectionsMatch(left, right) {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function hasUnsavedCategoryChanges() {
  return (
    editor.mode === "categories" &&
    !editor.pending &&
    !selectionsMatch(editor.selected, editor.originalSelected)
  );
}

function confirmDiscardChanges(anchor, action) {
  if (!hasUnsavedCategoryChanges()) {
    action();
    return;
  }
  const rect = (anchor ?? $("#slo-dips-content"))?.getBoundingClientRect() ?? {
    left: 24,
    top: 24,
  };
  openContextMenu(rect.left + 12, rect.top + 12, [
    { label: "Discard category changes", danger: true, action },
    { label: "Cancel", action() {} },
  ]);
}

function categoryEmoji(category) {
  if (category.emoji_url) {
    return html`<img class="slo-category-emoji" src="${category.emoji_url}" alt="" aria-hidden="true" />`;
  }
  return category.emoji
    ? html`<span class="slo-category-emoji-fallback" aria-hidden="true">${category.emoji}</span>`
    : "";
}

async function loadRepositories({ focusRepoId = null } = {}) {
  try {
    repositories = await invoke("list_slo_dips_repos");
    if (activeRepoId != null && !activeRepository()) {
      activeRepoId = null;
      editor = { mode: "idle" };
    }
    if (filterRepoId != null && !repositories.some((repo) => repo.id === filterRepoId)) {
      filterRepoId = null;
    }
    render();
    if (focusRepoId != null) {
      $(`#slo-dips-repo-list [data-repo-id="${focusRepoId}"]`)?.focus();
    }
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function render() {
  renderSidebar();
  renderContent();
}

function renderSidebar() {
  const editorOpen = editor.mode === "categories" || editor.mode === "loading";
  const highlightId = editorOpen ? (editor.repository?.id ?? null) : filterRepoId;

  const filterList = $("#slo-dips-filter-list");
  if (filterList) {
    if (!repositories.length) {
      filterList.innerHTML = "";
    } else {
      const totals = summarize(dips);
      filterList.innerHTML = sourceButton({
        icon: ALL_ICON,
        label: "All",
        labelTitle: `All repositories · ${totals.investigated}/${totals.total} dips investigated`,
        attrs: html`data-filter="all"`,
        active: !editorOpen && filterRepoId == null,
        count: `${totals.investigated}/${totals.total}`,
      });
      filterList.querySelector('[data-filter="all"]')?.addEventListener("click", (event) => {
        confirmDiscardChanges(event.currentTarget, showAllDips);
      });
    }
  }

  const list = $("#slo-dips-repo-list");
  if (!list) return;
  if (!repositories.length) {
    list.innerHTML = html`<li class="source-empty">No repositories yet.</li>`;
    return;
  }
  const counts = countDipsByRepoId(dips);
  list.innerHTML = repositories
    .map((repository) => {
      const tally = counts.get(repository.id) ?? { total: 0, investigated: 0 };
      return sourceButton({
        icon: REPO_ICON,
        label: repository.full_name,
        labelTitle: `${repository.full_name} · ${tally.investigated}/${tally.total} dips investigated`,
        lock: repository.private,
        className: "repo-source",
        attrs: html`data-repo-id="${repository.id}"`,
        active: repository.id === highlightId,
        count: `${tally.investigated}/${tally.total}`,
      });
    })
    .join("");
}

function renderTitle(repository = null) {
  const title = $("#slo-dips-view-title");
  if (!title) return;
  if (!repository) {
    title.textContent = editor.mode === "add" ? "Add repository" : "SLO Dips";
    title.removeAttribute("aria-label");
    return;
  }
  title.innerHTML = html`SLO Dips<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${repository.full_name}</span>`;
  title.setAttribute("aria-label", `SLO Dips, repository ${repository.full_name}`);
}

function renderContent() {
  const content = $("#slo-dips-content");
  if (!content) return;
  if (editor.mode === "add") {
    renderTitle();
    content.innerHTML = html`
      <div class="slo-editor-card">
        <h2>Add a repository</h2>
        <p class="slo-editor-intro">Enter a repository, then choose the GitHub Discussion categories that contain SLO dips.</p>
        <label class="slo-repo-field">
          Repository
          <input id="slo-repo-input" type="text" autocomplete="off" placeholder="org/repo-name" value="${editor.repositoryInput ?? ""}" aria-describedby="slo-editor-error" ${editor.pending ? rawHtml("disabled") : ""} />
        </label>
        <p class="slo-repo-error" id="slo-editor-error" role="alert" tabindex="-1">${editor.error ?? ""}</p>
        <div class="slo-editor-actions">
          <button type="button" class="btn" data-editor-action="cancel" ${editor.pending ? rawHtml("disabled") : ""}>Cancel</button>
          <button type="button" class="btn btn--primary" data-editor-action="inspect" ${editor.pending ? rawHtml("disabled") : ""}>
            Continue ${editor.pending ? rawHtml('<span class="spinner spinner--button" aria-hidden="true"></span>') : ""}
          </button>
        </div>
      </div>`;
    content.querySelector('[data-editor-action="cancel"]').addEventListener("click", closeEditor);
    content
      .querySelector('[data-editor-action="inspect"]')
      .addEventListener("click", inspectAddInput);
    content.querySelector("#slo-repo-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        inspectAddInput();
      }
    });
    return;
  }

  if (editor.mode === "loading") {
    renderTitle(editor.repository);
    content.innerHTML = html`
      <div class="slo-editor-card">
        <div class="slo-editor-loading" role="status">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading Discussion categories for ${editor.repository.full_name}…</span>
        </div>
        <div class="slo-editor-actions">
          <button type="button" class="btn" data-editor-action="cancel">Cancel</button>
        </div>
      </div>`;
    content.querySelector('[data-editor-action="cancel"]').addEventListener("click", closeEditor);
    return;
  }

  if (editor.mode === "categories") {
    renderCategoryEditor(content);
    return;
  }

  renderTitle();
  renderDipsView(content);
}

const DATADOG_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm0 2.4l3.6 3.6-1.2 1.2L8 8.4 5.6 8.7 4.4 7.5 8 3.9z" fill="currentColor"/></svg>`;

/** The home/idle view: the collected SLO dips, grouped by repository. Renders instantly from
 *  SQLite and is re-rendered after a refresh. Left-clicking a sidebar repo filters this list;
 *  configuring categories lives behind the sidebar right-click menu. */
function renderDipsView(content) {
  if (!repositories.length) {
    content.innerHTML = html`
      <div class="module-placeholder">
        <img class="module-placeholder-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
        <p class="module-placeholder-title">Add a repository to begin.</p>
        <p class="module-placeholder-sub">Track a repository's SLO-investigation Discussions to collect dips here.</p>
      </div>`;
    return;
  }

  if (!dipsLoaded && !dips.length) {
    content.innerHTML = html`
      <div class="slo-editor-loading" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span>Loading SLO dips…</span>
      </div>`;
    return;
  }

  const filterRepo =
    filterRepoId != null ? repositories.find((repo) => repo.id === filterRepoId) : null;
  const visibleDips = filterRepo ? dips.filter((dip) => dip.repo_id === filterRepoId) : dips;

  if (!visibleDips.length) {
    content.innerHTML = html`
      <div class="module-placeholder">
        <img class="module-placeholder-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
        <p class="module-placeholder-title">${filterRepo ? html`No SLO dips for ${filterRepo.full_name} in the last 60 days.` : "No SLO dips in the last 60 days."}</p>
        <p class="module-placeholder-sub">${filterRepo ? rawHtml(html`<button type="button" class="slo-dips-clear-filter" data-clear-filter>Show all repositories</button>`) : dipsError ? dipsError : rawHtml("Nice — nothing to investigate. Use Refresh to check GitHub again.")}</p>
      </div>`;
    return;
  }

  const totals = summarize(visibleDips);
  const groups = groupDipsByRepo(visibleDips);
  content.innerHTML = html`
    <div class="slo-dips-view">
      <div class="slo-dips-summary" aria-live="polite">
        <span class="slo-dips-summary-total">${totals.total} ${totals.total === 1 ? "dip" : "dips"}</span>
        <span class="slo-dip-badge slo-dip-badge--pending">${totals.pending} pending</span>
        <span class="slo-dip-badge slo-dip-badge--investigated">${totals.investigated} investigated</span>
        ${filterRepo ? rawHtml(html`<button type="button" class="slo-dips-clear-filter" data-clear-filter title="Show all repositories">${filterRepo.full_name} <span aria-hidden="true">✕</span></button>`) : rawHtml('<span class="slo-dips-window">last 60 days</span>')}
      </div>
      ${rawHtml(groups.map(renderRepoGroup).join(""))}
    </div>`;
}

function renderRepoGroup(group) {
  return html`
    <section class="slo-dip-repo" aria-labelledby="${repoDomId(group.repoFullName)}">
      <header class="slo-dip-repo-head">
        <h2 class="slo-dip-repo-name" id="${repoDomId(group.repoFullName)}">${group.repoFullName}</h2>
        <span class="slo-dip-repo-counts">${group.pending ? rawHtml(html`<span class="slo-dip-badge slo-dip-badge--pending">${group.pending} pending</span>`) : rawHtml('<span class="slo-dip-badge slo-dip-badge--investigated">all investigated</span>')}</span>
      </header>
      <ul class="slo-dip-list">
        ${rawHtml(DIP_HEADER_ROW)}
        ${rawHtml(group.dips.map(renderDipRow).join(""))}
      </ul>
    </section>`;
}

const DIP_HEADER_ROW = html`
  <li class="slo-dip-head" aria-hidden="true">
    <span>Date</span>
    <span>SLO</span>
    <span class="slo-dip-head-num">Attainment</span>
    <span>Status</span>
  </li>`;

function renderDipRow(dip) {
  const status = dipStatus(dip);
  const rel = relTime(`${dip.dip_date}T00:00:00`);
  const relCell = rel ? rawHtml(html`<span class="slo-dip-date-rel">${rel}</span>`) : "";
  const statusCell = rawHtml(renderStatusCell(dip, status));
  return html`
    <li class="slo-dip-row slo-dip-row--${status}">
      <span class="slo-dip-date">
        <span class="slo-dip-date-abs">${dip.dip_date}</span>
        ${relCell}
      </span>
      <span class="slo-dip-name">
        <button type="button" class="slo-dip-link" data-open-url="${dip.comment_url}">${dip.slo_name}</button>
        ${dip.slo_url ? rawHtml(html`<button type="button" class="slo-dip-datadog" data-open-url="${dip.slo_url}" title="Open in Datadog" aria-label="Open ${dip.slo_name} in Datadog">${rawHtml(DATADOG_ICON)}</button>`) : ""}
      </span>
      <span class="slo-dip-percent">${formatPercent(dip.percent)}</span>
      ${statusCell}
    </li>`;
}

/** Status column: a plain "pending" pill, or an investigated pill normalized to the responder's
 *  GitHub handle plus their avatar so investigators are scannable at a glance. */
function renderStatusCell(dip, status) {
  if (status !== "investigated") {
    return html`<span class="slo-dip-badge slo-dip-badge--pending">pending</span>`;
  }
  if (!dip.investigated_by) {
    return html`<span class="slo-dip-badge slo-dip-badge--investigated">investigated</span>`;
  }
  const when = dip.investigated_at ? ` · ${relTime(dip.investigated_at)}` : "";
  return html`<span class="slo-dip-badge slo-dip-badge--investigated" title="Investigated by ${dip.investigated_by}${when}">
    <img class="slo-dip-avatar" src="${avatarUrl(dip.investigated_by)}" alt="" width="16" height="16" loading="lazy" />
    <span class="slo-dip-investigator">${dip.investigated_by}</span>
  </span>`;
}

function renderCategoryEditor(content) {
  const { inspection, selected, purpose, staleCount = 0, pending = false, error = "" } = editor;
  const repository = inspection.repository;
  renderTitle(repository);
  content.innerHTML = html`
    <div class="slo-editor-card">
      <div class="slo-editor-heading">
        <div>
          <h2 id="slo-editor-heading" tabindex="-1">${repository.full_name}${repository.private ? " 🔒" : ""}</h2>
          <p class="slo-editor-intro">${purpose === "add" ? "Choose the categories to track before adding this repository." : "Choose the Discussion categories Helix should use as SLO dip sources."}</p>
        </div>
        <span class="slo-selection-count" aria-live="polite">${selected.size} ${selected.size === 1 ? "category" : "categories"} selected</span>
      </div>
      ${staleCount ? rawHtml(html`<p class="slo-category-warning">${staleCount} previously selected ${staleCount === 1 ? "category is" : "categories are"} no longer available on GitHub.</p>`) : ""}
      <fieldset class="slo-category-fieldset" ${pending ? rawHtml("disabled") : ""}>
        <legend>Discussion categories</legend>
        <div class="slo-category-options">
          ${rawHtml(
            inspection.categories
              .map(
                (category) => html`
                  <label class="slo-category-option">
                    <input type="checkbox" value="${category.id}" ${selected.has(category.id) ? rawHtml("checked") : ""} />
                    <span class="slo-category-option-text">
                      <span class="slo-category-option-name">${rawHtml(categoryEmoji(category))}${category.name}</span>
                      ${category.description ? rawHtml(html`<span class="slo-category-option-desc">${category.description}</span>`) : ""}
                    </span>
                  </label>`,
              )
              .join(""),
          )}
        </div>
      </fieldset>
      <p class="slo-repo-error" id="slo-editor-error" role="alert" tabindex="-1">${error}</p>
      <div class="slo-editor-actions">
        ${purpose === "add" ? rawHtml(html`<button type="button" class="btn" data-editor-action="back" ${pending ? rawHtml("disabled") : ""}>Back</button>`) : rawHtml(html`<button type="button" class="btn" data-editor-action="back-to-dips" ${pending ? rawHtml("disabled") : ""}>Back to dips</button><button type="button" class="btn" data-editor-action="reset" ${pending ? rawHtml("disabled") : ""}>Reset</button>`)}
        <button type="button" class="btn btn--primary" data-editor-action="save" ${pending ? rawHtml("disabled") : ""}>
          ${purpose === "add" ? "Add repository" : "Save categories"}
          ${pending ? rawHtml('<span class="spinner spinner--button" aria-hidden="true"></span>') : ""}
        </button>
      </div>
    </div>`;
  for (const checkbox of content.querySelectorAll('.slo-category-option input[type="checkbox"]')) {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) editor.selected.add(checkbox.value);
      else editor.selected.delete(checkbox.value);
      editor.error = "";
      renderContent();
      content.querySelector(`input[value="${CSS.escape(checkbox.value)}"]`)?.focus();
    });
  }
  content.querySelector('[data-editor-action="back"]')?.addEventListener("click", () => {
    editor = {
      mode: "add",
      repositoryInput: editor.repositoryInput,
      pending: false,
      error: "",
    };
    renderContent();
    $("#slo-repo-input")?.focus();
  });
  content.querySelector('[data-editor-action="reset"]')?.addEventListener("click", resetSelection);
  content
    .querySelector('[data-editor-action="back-to-dips"]')
    ?.addEventListener("click", () => confirmDiscardChanges(null, closeEditor));
  content.querySelector('[data-editor-action="save"]').addEventListener("click", saveCategories);
}

function beginAdd() {
  requestSequence += 1;
  activeRepoId = null;
  editor = { mode: "add", repositoryInput: "", pending: false, error: "" };
  render();
  $("#slo-repo-input")?.focus();
}

function closeEditor() {
  requestSequence += 1;
  activeRepoId = null;
  editor = { mode: "idle" };
  render();
  $("#slo-dips-add-repo")?.focus();
}

/** Sidebar left-click: filter the dips list to one repository (or clear if it's already the
 *  active filter). Closes any open category editor and cancels in-flight editor loads. */
function toggleFilter(repoId) {
  requestSequence += 1;
  activeRepoId = null;
  editor = { mode: "idle" };
  filterRepoId = filterRepoId === repoId ? null : repoId;
  render();
  $(`#slo-dips-repo-list [data-repo-id="${repoId}"]`)?.focus();
}

/** Sidebar "All": clear any repo filter and close the editor, returning to the full dips list. */
function showAllDips() {
  requestSequence += 1;
  activeRepoId = null;
  editor = { mode: "idle" };
  filterRepoId = null;
  render();
  $('#slo-dips-filter-list [data-filter="all"]')?.focus();
}

async function inspectAddInput() {
  const repositoryInput = $("#slo-repo-input")?.value.trim() ?? "";
  const requestId = ++requestSequence;
  editor = { mode: "add", repositoryInput, pending: true, error: "" };
  renderContent();
  try {
    const inspection = await invoke("inspect_slo_dips_repo", { repository: repositoryInput });
    if (requestId !== requestSequence) return;
    if (!inspection.categories.length) {
      throw new Error(
        "This repository has no GitHub Discussion categories. Enable Discussions and add a category first.",
      );
    }
    editor = {
      mode: "categories",
      purpose: "add",
      repositoryInput,
      inspection,
      selected: new Set(),
      originalSelected: new Set(),
      pending: false,
      error: "",
    };
  } catch (error) {
    if (requestId !== requestSequence) return;
    editor = { mode: "add", repositoryInput, pending: false, error: errorText(error) };
  }
  renderContent();
  if (editor.error) $("#slo-editor-error")?.focus();
  else $("#slo-editor-heading")?.focus();
}

async function selectRepository(repoId) {
  const repository = repositories.find((candidate) => candidate.id === repoId);
  if (!repository) return;
  activeRepoId = repoId;
  const requestId = ++requestSequence;
  editor = { mode: "loading", repository };
  render();
  try {
    const inspection = await invoke("inspect_slo_dips_repo", {
      repository: repository.full_name,
    });
    if (requestId !== requestSequence) return;
    if (!inspection.categories.length) {
      throw new Error("This repository no longer has any GitHub Discussion categories.");
    }
    const selected = new Set(
      repository.categories
        .map((category) => category.id)
        .filter((id) => inspection.categories.some((category) => category.id === id)),
    );
    editor = {
      mode: "categories",
      purpose: "edit",
      repository,
      inspection,
      selected,
      originalSelected: new Set(selected),
      staleCount: repository.categories.length - selected.size,
      pending: false,
      error: "",
    };
  } catch (error) {
    if (requestId !== requestSequence) return;
    editor = {
      mode: "categories",
      purpose: "edit",
      repository,
      inspection: {
        repository,
        categories: repository.categories.map((category) => ({
          ...category,
          description: null,
        })),
      },
      selected: new Set(repository.categories.map((category) => category.id)),
      originalSelected: new Set(repository.categories.map((category) => category.id)),
      pending: false,
      error: errorText(error),
    };
  }
  render();
  $("#slo-editor-heading")?.focus();
}

function resetSelection() {
  const repository = activeRepository();
  if (!repository || editor.mode !== "categories") return;
  editor.selected = new Set(
    repository.categories
      .map((category) => category.id)
      .filter((id) => editor.inspection.categories.some((category) => category.id === id)),
  );
  editor.originalSelected = new Set(editor.selected);
  editor.error = "";
  renderContent();
}

async function saveCategories() {
  if (!editor.selected.size) {
    editor.error = "Select at least one GitHub Discussion category.";
    renderContent();
    $("#slo-editor-error")?.focus();
    return;
  }
  const requestState = editor;
  const requestId = ++requestSequence;
  const categoryIds = [...editor.selected];
  editor.pending = true;
  editor.error = "";
  renderContent();
  try {
    const repository =
      editor.purpose === "edit"
        ? await invoke("update_slo_dips_repo_categories", {
            repoId: editor.repository.id,
            categoryIds,
          })
        : await invoke("add_slo_dips_repo", {
            repository: editor.repositoryInput,
            categoryIds,
          });
    if (requestId !== requestSequence) {
      await loadRepositories();
      return;
    }
    activeRepoId = repository.id;
    await loadRepositories();
    const stored = activeRepository() ?? repository;
    editor = {
      mode: "categories",
      purpose: "edit",
      repository: stored,
      inspection: requestState.inspection,
      selected: new Set(stored.categories.map((category) => category.id)),
      originalSelected: new Set(stored.categories.map((category) => category.id)),
      pending: false,
      error: "",
    };
    render();
    $("#slo-dips-content [data-editor-action='save']")?.focus();
    toast(
      requestState.purpose === "edit"
        ? "Discussion categories updated."
        : "SLO Dips repository added.",
    );
  } catch (error) {
    if (requestId !== requestSequence) return;
    if (String(error).includes(STALE_CATEGORIES_CODE)) {
      try {
        const inspection = await invoke("inspect_slo_dips_repo", {
          repository: requestState.repositoryInput ?? requestState.repository.full_name,
        });
        editor = {
          ...requestState,
          inspection,
          selected: new Set(
            categoryIds.filter((id) =>
              inspection.categories.some((category) => category.id === id),
            ),
          ),
          originalSelected: new Set(requestState.originalSelected),
          pending: false,
          error: errorText(error),
        };
      } catch (reloadError) {
        editor = { ...requestState, pending: false, error: errorText(reloadError) };
      }
    } else {
      editor = { ...requestState, pending: false, error: errorText(error) };
    }
    renderContent();
    $("#slo-editor-error")?.focus();
  }
}

function openRepositoryMenu(event, repository) {
  event.preventDefault();
  openContextMenu(event.clientX, event.clientY, [
    {
      label: "Show categories",
      action: () => confirmDiscardChanges(null, () => selectRepository(repository.id)),
    },
    {
      label: "Remove repository",
      danger: true,
      action: () => openRemoveConfirmation(event.clientX, event.clientY, repository),
    },
  ]);
}

function openRemoveConfirmation(x, y, repository) {
  openContextMenu(x, y, [
    {
      label: `Confirm: remove ${repository.full_name}`,
      danger: true,
      action: () => removeRepository(repository),
    },
    { label: "Cancel", action() {} },
  ]);
}

async function removeRepository(repository) {
  const index = repositories.findIndex((candidate) => candidate.id === repository.id);
  const fallback = repositories[index + 1] ?? repositories[index - 1] ?? null;
  try {
    await invoke("remove_slo_dips_repo", { repoId: repository.id });
    if (activeRepoId === repository.id) {
      activeRepoId = null;
      editor = { mode: "idle" };
    }
    await loadRepositories({ focusRepoId: fallback?.id ?? null });
    if (!fallback) $("#slo-dips-add-repo")?.focus();
    toast("SLO Dips repository removed.");
  } catch (error) {
    toast(errorText(error), "error");
  }
}

function setSyncState(state) {
  const dot = $(".js-slo-sync-dot");
  const label = $(".js-slo-sync-label");
  const button = $(".js-slo-refresh-btn");
  if (button) {
    button.disabled = state === "refreshing";
    button.classList.toggle("is-spinning", state === "refreshing");
  }
  const text = state === "refreshing" ? "Refreshing…" : state === "error" ? "Refresh failed" : "";
  for (const el of [dot, label]) {
    if (el) el.hidden = state === "idle";
  }
  if (dot)
    dot.className = `status-dot status-dot--${state === "error" ? "error" : "pending"} js-slo-sync-dot`;
  if (label) {
    label.className = `status-label status-label--${state === "error" ? "error" : "pending"} js-slo-sync-label`;
    label.textContent = text;
  }
}

/** Read the collected dips from SQLite (offline-first) and repaint the home view. Never hits
 *  the network. */
async function loadDips() {
  const token = ++requestSequence;
  try {
    const result = await invoke("list_slo_dips");
    if (token !== requestSequence) return;
    dips = result;
    dipsError = "";
  } catch (error) {
    if (token !== requestSequence) return;
    dipsError = errorText(error);
  } finally {
    if (token === requestSequence) {
      dipsLoaded = true;
      renderSidebar();
      if (editor.mode === "idle") renderContent();
    }
  }
}

/** Fetch fresh dips from GitHub, reconcile them into SQLite, and repaint. Concurrency-guarded
 *  so overlapping refreshes (auto + button) collapse into one; a request token ensures a slow
 *  SQLite read can't clobber a newer network result (or vice versa). */
async function refreshDips() {
  if (refreshing) return;
  refreshing = true;
  autoRefreshed = true;
  const token = ++requestSequence;
  setSyncState("refreshing");
  try {
    const result = await invoke("refresh_slo_dips");
    if (token === requestSequence) {
      dips = result;
      dipsError = "";
      dipsLoaded = true;
    }
    setSyncState("idle");
  } catch (error) {
    if (token === requestSequence) dipsError = errorText(error);
    setSyncState("error");
    toast(errorText(error), "error");
  } finally {
    refreshing = false;
    renderSidebar();
    if (editor.mode === "idle") renderContent();
  }
}

function initSloDips() {
  $("#slo-dips-add-repo")?.addEventListener("click", (event) => {
    confirmDiscardChanges(event.currentTarget, beginAdd);
  });
  $(".js-slo-refresh-btn")?.addEventListener("click", refreshDips);
  $("#slo-dips-content")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-clear-filter]")) {
      toggleFilter(filterRepoId);
      return;
    }
    const source = target?.closest("[data-open-url]");
    const url = source?.dataset.openUrl;
    if (!url) return;
    invoke("open_url", { url }).catch((error) => {
      console.error(`failed to open ${url}: ${error}`);
      toast("Couldn't open link", "error");
    });
  });
  const list = $("#slo-dips-repo-list");
  list?.addEventListener("click", (event) => {
    const source = event.target instanceof Element ? event.target.closest("[data-repo-id]") : null;
    if (!source) return;
    const repoId = Number(source.dataset.repoId);
    confirmDiscardChanges(source, () => toggleFilter(repoId));
  });
  list?.addEventListener("contextmenu", (event) => {
    const source = event.target instanceof Element ? event.target.closest("[data-repo-id]") : null;
    const repository = repositories.find(
      (candidate) => candidate.id === Number(source?.dataset.repoId),
    );
    if (source && repository) openRepositoryMenu(event, repository);
  });
  list?.addEventListener("keydown", (event) => {
    if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    const source = event.target instanceof Element ? event.target.closest("[data-repo-id]") : null;
    const repository = repositories.find(
      (candidate) => candidate.id === Number(source?.dataset.repoId),
    );
    if (!source || !repository) return;
    const rect = source.getBoundingClientRect();
    openRepositoryMenu(
      {
        preventDefault: () => event.preventDefault(),
        clientX: rect.left + 12,
        clientY: rect.top + 12,
      },
      repository,
    );
  });
}

async function loadModule() {
  await loadRepositories();
  await loadDips();
}

/** On module open: render from SQLite instantly (done by `load`), then auto-fetch from GitHub
 *  exactly once per session. No polling — subsequent refreshes are user-driven via the button.
 *  Skips the network entirely when not connected. */
function activateModule() {
  if (autoRefreshed || !isAuthenticated()) return;
  refreshDips();
}

registerModule("slo-dips", {
  sidebarSelector: "#sidebar-slo-dips",
  init: initSloDips,
  load: loadModule,
  activate: activateModule,
});
