import { invoke } from "./api.js";
import { $, html, rawHtml, toast } from "./dom.js";
import { openContextMenu } from "./menu.js";
import { registerModule } from "./modules.js";
import { sourceButton } from "./ui.js";

const REPO_ICON = `<svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 2.5h7.5L13 5v8.5H3z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 6h4M5 8.5h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const STALE_CATEGORIES_CODE = "SLO_DIPS_STALE_CATEGORIES:";

let repositories = [];
let activeRepoId = null;
let overlay = null;
let returnFocus = null;
let modalState = null;

function activeRepository() {
  return repositories.find((repository) => repository.id === activeRepoId) ?? null;
}

async function loadRepositories({ focusRepoId = null } = {}) {
  try {
    repositories = await invoke("list_slo_dips_repos");
    if (activeRepoId != null && !activeRepository()) activeRepoId = null;
    render();
    if (focusRepoId != null) {
      $(`#slo-dips-repo-list [data-repo-id="${focusRepoId}"]`)?.focus();
    }
  } catch (error) {
    toast(String(error), "error");
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

function renderContent() {
  const title = $("#slo-dips-view-title");
  const placeholder = $("#slo-dips-placeholder");
  if (!title || !placeholder) return;
  const repository = activeRepository();
  if (!repository) {
    title.textContent = "SLO Dips";
    title.removeAttribute("aria-label");
    placeholder.innerHTML = html`
      <img class="module-placeholder-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
      <p class="module-placeholder-title">${repositories.length ? "Select a repository." : "Add a repository to begin."}</p>
      <p class="module-placeholder-sub">Choose the GitHub Discussion categories that will provide SLO dips.</p>`;
    return;
  }
  title.innerHTML = html`SLO Dips<span class="crumb-sep" aria-hidden="true">›</span><span class="crumb-repo">${repository.full_name}</span>`;
  title.setAttribute("aria-label", `SLO Dips, repository ${repository.full_name}`);
  placeholder.innerHTML = html`
    <img class="module-placeholder-art" src="/assets/helix-muted.svg" alt="" width="116" height="116" />
    <p class="module-placeholder-title">${repository.full_name}</p>
    <p class="module-placeholder-sub">Tracking ${repository.categories.length} Discussion ${repository.categories.length === 1 ? "category" : "categories"} for future SLO dips.</p>
    <ul class="slo-category-list" aria-label="Selected Discussion categories">
      ${rawHtml(
        repository.categories
          .map(
            (category) =>
              html`<li>${category.emoji ? `${category.emoji} ` : ""}${category.name}</li>`,
          )
          .join(""),
      )}
    </ul>`;
}

function selectRepository(repoId) {
  activeRepoId = repoId;
  render();
}

function modalFocusable() {
  return overlay
    ? [
        ...overlay.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hidden)
    : [];
}

function errorText(error) {
  return String(error)
    .replace(/^Error:\s*/, "")
    .replace(`${STALE_CATEGORIES_CODE} `, "");
}

function modalCanClose() {
  return !modalState?.pending || modalState.pendingKind === "inspect";
}

function onModalKeydown(event) {
  if (!overlay) return;
  if (event.key === "Escape" && modalCanClose()) {
    event.preventDefault();
    closeModal();
  } else if (event.key === "Tab") {
    const focusable = modalFocusable();
    if (!focusable.length) return;
    const index = focusable.indexOf(document.activeElement);
    if (index < 0) {
      event.preventDefault();
      (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
    } else if (event.shiftKey && index === 0) {
      event.preventDefault();
      focusable.at(-1)?.focus();
    } else if (!event.shiftKey && index === focusable.length - 1) {
      event.preventDefault();
      focusable[0]?.focus();
    }
  }
}

function openOverlay() {
  if (overlay) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay = document.createElement("div");
  overlay.className = "slo-repo-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "slo-repo-dialog-title");
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay && modalCanClose()) closeModal();
  });
  document.addEventListener("keydown", onModalKeydown, true);
  document.body.appendChild(overlay);
}

function closeModal() {
  if (!overlay) return;
  overlay.remove();
  document.removeEventListener("keydown", onModalKeydown, true);
  overlay = null;
  modalState = null;
  const target = returnFocus;
  returnFocus = null;
  if (target && document.contains(target)) target.focus();
}

function setModalError(message) {
  const error = $("#slo-repo-modal-error");
  if (error) error.textContent = message ? errorText(message) : "";
}

function setPending(pending, pendingKind = "") {
  if (!modalState || !overlay) return;
  modalState.pending = pending;
  modalState.pendingKind = pending ? pendingKind : "";
  for (const control of overlay.querySelectorAll("button, input")) {
    const cancellableInspect =
      pendingKind === "inspect" && control.matches('[data-modal-action="cancel"]');
    control.disabled = pending && !cancellableInspect;
  }
  for (const spinner of overlay.querySelectorAll(".slo-modal-spinner")) {
    spinner.hidden = !pending;
  }
  overlay.setAttribute("aria-busy", String(pending));
}

function openAddModal() {
  openOverlay();
  modalState = { mode: "add", step: "repository", pending: false, repositoryInput: "" };
  renderRepositoryStep();
}

function renderRepositoryStep() {
  overlay.innerHTML = html`
    <div class="slo-repo-dialog" role="document">
      <h2 id="slo-repo-dialog-title">Add SLO Dips repository</h2>
      <p class="slo-repo-dialog-intro">Enter a repository, then choose the Discussion categories that contain SLO dips.</p>
      <label class="slo-repo-field">
        Repository
        <input id="slo-repo-input" type="text" autocomplete="off" placeholder="org/repo-name" value="${modalState.repositoryInput ?? ""}" aria-describedby="slo-repo-modal-error" />
      </label>
      <p class="slo-repo-error" id="slo-repo-modal-error" role="alert"></p>
      <div class="slo-repo-actions">
        <button type="button" class="btn" data-modal-action="cancel">Cancel</button>
        <button type="button" class="btn btn--primary" data-modal-action="inspect">
          Continue <span class="spinner slo-modal-spinner" aria-hidden="true" hidden></span>
        </button>
      </div>
    </div>`;
  overlay.querySelector('[data-modal-action="cancel"]').addEventListener("click", closeModal);
  overlay.querySelector('[data-modal-action="inspect"]').addEventListener("click", inspectAddInput);
  overlay.querySelector("#slo-repo-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      inspectAddInput();
    }
  });
  overlay.querySelector("#slo-repo-input")?.focus();
}

async function inspectAddInput() {
  const input = $("#slo-repo-input");
  modalState.repositoryInput = input?.value.trim() ?? "";
  const requestState = modalState;
  setModalError("");
  setPending(true, "inspect");
  try {
    const inspection = await invoke("inspect_slo_dips_repo", {
      repository: modalState.repositoryInput,
    });
    if (modalState !== requestState) return;
    if (!inspection.categories.length) {
      throw new Error(
        "This repository has no GitHub Discussion categories. Enable Discussions and add a category first.",
      );
    }
    modalState.inspection = inspection;
    modalState.selected = new Set();
    modalState.step = "categories";
    renderCategoryStep();
  } catch (error) {
    if (modalState !== requestState) return;
    setPending(false);
    setModalError(error);
  }
}

async function openEditModal(repository) {
  openOverlay();
  modalState = {
    mode: "edit",
    pending: true,
    pendingKind: "inspect",
    repositoryInput: repository.full_name,
    repository,
  };
  overlay.innerHTML = html`
    <div class="slo-repo-dialog" role="document">
      <h2 id="slo-repo-dialog-title">Edit Discussion categories</h2>
      <p class="slo-repo-dialog-intro"><span class="spinner" aria-hidden="true"></span> Loading categories for ${repository.full_name}…</p>
      <div class="slo-repo-actions">
        <button type="button" class="btn" data-modal-action="cancel">Cancel</button>
      </div>
    </div>`;
  overlay.querySelector('[data-modal-action="cancel"]').addEventListener("click", closeModal);
  overlay.setAttribute("aria-busy", "true");
  const requestState = modalState;
  try {
    const inspection = await invoke("inspect_slo_dips_repo", {
      repository: repository.full_name,
    });
    if (modalState !== requestState) return;
    if (!inspection.categories.length) {
      throw new Error("This repository no longer has any GitHub Discussion categories.");
    }
    modalState.inspection = inspection;
    modalState.selected = new Set(
      repository.categories
        .map((category) => category.id)
        .filter((id) => inspection.categories.some((category) => category.id === id)),
    );
    modalState.staleCount = repository.categories.length - modalState.selected.size;
    modalState.pending = false;
    renderCategoryStep();
  } catch (error) {
    if (modalState !== requestState) return;
    modalState.pending = false;
    overlay.setAttribute("aria-busy", "false");
    overlay.innerHTML = html`
      <div class="slo-repo-dialog" role="document">
        <h2 id="slo-repo-dialog-title">Edit Discussion categories</h2>
        <p class="slo-repo-error" role="alert">${errorText(error)}</p>
        <div class="slo-repo-actions">
          <button type="button" class="btn" data-modal-action="cancel">Close</button>
        </div>
      </div>`;
    overlay.querySelector("button")?.addEventListener("click", closeModal);
    overlay.querySelector("button")?.focus();
  }
}

function selectionSummary() {
  const count = modalState.selected.size;
  return count
    ? `${count} ${count === 1 ? "category" : "categories"} selected`
    : "Select categories";
}

function renderCategoryStep(errorMessage = "") {
  const { inspection, selected, mode, staleCount = 0 } = modalState;
  overlay.setAttribute("aria-busy", "false");
  overlay.innerHTML = html`
    <div class="slo-repo-dialog" role="document">
      <h2 id="slo-repo-dialog-title">${mode === "edit" ? "Edit Discussion categories" : "Choose Discussion categories"}</h2>
      <p class="slo-category-repo">${inspection.repository.full_name}${inspection.repository.private ? " 🔒" : ""}</p>
      ${staleCount ? rawHtml(html`<p class="slo-category-warning">${staleCount} previously selected ${staleCount === 1 ? "category is" : "categories are"} no longer available on GitHub.</p>`) : ""}
      <details class="slo-category-picker">
        <summary id="slo-category-summary">${selectionSummary()}</summary>
        <div class="slo-category-options">
          ${rawHtml(
            inspection.categories
              .map(
                (category) => html`
                  <label class="slo-category-option">
                    <input type="checkbox" value="${category.id}" ${selected.has(category.id) ? rawHtml("checked") : ""} />
                    <span class="slo-category-option-text">
                      <span>${category.emoji ? `${category.emoji} ` : ""}${category.name}</span>
                      ${category.description ? rawHtml(html`<span class="slo-category-option-desc">${category.description}</span>`) : ""}
                    </span>
                  </label>`,
              )
              .join(""),
          )}
        </div>
      </details>
      <p class="slo-repo-error" id="slo-repo-modal-error" role="alert">${errorMessage}</p>
      <div class="slo-repo-actions">
        ${mode === "add" ? rawHtml(html`<button type="button" class="btn" data-modal-action="back">Back</button>`) : ""}
        <button type="button" class="btn" data-modal-action="cancel">Cancel</button>
        <button type="button" class="btn btn--primary" data-modal-action="save">
          ${mode === "edit" ? "Save categories" : "Add repository"}
          <span class="spinner slo-modal-spinner" aria-hidden="true" hidden></span>
        </button>
      </div>
    </div>`;
  for (const checkbox of overlay.querySelectorAll('.slo-category-option input[type="checkbox"]')) {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) modalState.selected.add(checkbox.value);
      else modalState.selected.delete(checkbox.value);
      $("#slo-category-summary").textContent = selectionSummary();
      setModalError("");
    });
  }
  overlay
    .querySelector('[data-modal-action="back"]')
    ?.addEventListener("click", renderRepositoryStep);
  overlay.querySelector('[data-modal-action="cancel"]').addEventListener("click", closeModal);
  overlay.querySelector('[data-modal-action="save"]').addEventListener("click", saveCategories);
  overlay.querySelector(".slo-category-picker summary")?.focus();
}

async function saveCategories() {
  if (!modalState.selected.size) {
    setModalError("Select at least one GitHub Discussion category.");
    return;
  }
  const categoryIds = [...modalState.selected];
  setPending(true, "save");
  try {
    const repository =
      modalState.mode === "edit"
        ? await invoke("update_slo_dips_repo_categories", {
            repoId: modalState.repository.id,
            categoryIds,
          })
        : await invoke("add_slo_dips_repo", {
            repository: modalState.repositoryInput,
            categoryIds,
          });
    activeRepoId = repository.id;
    const editing = modalState.mode === "edit";
    closeModal();
    await loadRepositories({ focusRepoId: editing ? repository.id : null });
    toast(editing ? "Discussion categories updated." : "SLO Dips repository added.");
  } catch (error) {
    setPending(false);
    if (String(error).includes(STALE_CATEGORIES_CODE)) {
      try {
        const inspection = await invoke("inspect_slo_dips_repo", {
          repository: modalState.repositoryInput,
        });
        modalState.inspection = inspection;
        modalState.selected = new Set(
          categoryIds.filter((id) => inspection.categories.some((category) => category.id === id)),
        );
        renderCategoryStep(errorText(error));
      } catch (reloadError) {
        setModalError(reloadError);
      }
    } else {
      setModalError(error);
    }
  }
}

function openRepositoryMenu(event, repository) {
  event.preventDefault();
  returnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  openContextMenu(event.clientX, event.clientY, [
    { label: "Edit categories", action: () => openEditModal(repository) },
    { separator: true },
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
    if (activeRepoId === repository.id) activeRepoId = null;
    await loadRepositories({ focusRepoId: fallback?.id ?? null });
    if (!fallback) $("#slo-dips-add-repo")?.focus();
    toast("SLO Dips repository removed.");
  } catch (error) {
    toast(String(error), "error");
  }
}

function initSloDips() {
  $("#slo-dips-add-repo")?.addEventListener("click", openAddModal);
  const list = $("#slo-dips-repo-list");
  list?.addEventListener("click", (event) => {
    const source = event.target instanceof Element ? event.target.closest("[data-repo-id]") : null;
    if (source) selectRepository(Number(source.dataset.repoId));
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
        currentTarget: source,
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
  deactivate: closeModal,
});
