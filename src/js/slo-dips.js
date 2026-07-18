import { invoke } from "./api.js";
import { $, html, rawHtml, toast } from "./dom.js";
import { openContextMenu } from "./menu.js";
import { registerModule } from "./modules.js";
import { sourceButton } from "./ui.js";

const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const STALE_CATEGORIES_CODE = "SLO_DIPS_STALE_CATEGORIES:";

let repositories = [];
let activeRepoId = null;
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
  const rect = anchor.getBoundingClientRect();
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
  const list = $("#slo-dips-repo-list");
  if (!list) return;
  if (!repositories.length) {
    list.innerHTML = html`<li class="source-empty">No repositories yet.</li>`;
    return;
  }
  list.innerHTML = repositories
    .map((repository) =>
      sourceButton({
        icon: REPO_ICON,
        label: repository.full_name,
        labelTitle: repository.full_name,
        lock: repository.private,
        className: "repo-source",
        attrs: html`data-repo-id="${repository.id}"`,
        active: repository.id === activeRepoId,
        count: String(repository.categories.length),
      }),
    )
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
  content.innerHTML = html`
    <div class="module-placeholder">
      <img class="module-placeholder-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
      <p class="module-placeholder-title">${repositories.length ? "Select a repository." : "Add a repository to begin."}</p>
      <p class="module-placeholder-sub">Repositories and their selected Discussion categories appear together here.</p>
    </div>`;
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
        ${purpose === "add" ? rawHtml(html`<button type="button" class="btn" data-editor-action="back" ${pending ? rawHtml("disabled") : ""}>Back</button>`) : rawHtml(html`<button type="button" class="btn" data-editor-action="reset" ${pending ? rawHtml("disabled") : ""}>Reset</button>`)}
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

function initSloDips() {
  $("#slo-dips-add-repo")?.addEventListener("click", (event) => {
    confirmDiscardChanges(event.currentTarget, beginAdd);
  });
  const list = $("#slo-dips-repo-list");
  list?.addEventListener("click", (event) => {
    const source = event.target instanceof Element ? event.target.closest("[data-repo-id]") : null;
    if (!source) return;
    const repoId = Number(source.dataset.repoId);
    if (repoId === activeRepoId && editor.mode === "categories") return;
    confirmDiscardChanges(source, () => selectRepository(repoId));
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

registerModule("slo-dips", {
  sidebarSelector: "#sidebar-slo-dips",
  init: initSloDips,
  load: loadRepositories,
});
