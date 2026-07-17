import { invoke } from "./api.js";

const confirmedCollapsedRepos = new Set();
const pendingCollapsedRepos = new Map();
const repoCollapseQueues = new Map();
const latestCollapseSeq = new Map();
const listeners = new Set();
let collapseSeq = 0;

function collapsedState(repoFullName) {
  return pendingCollapsedRepos.has(repoFullName)
    ? pendingCollapsedRepos.get(repoFullName)
    : confirmedCollapsedRepos.has(repoFullName);
}

function notify(repoFullName, collapsed) {
  for (const listener of listeners) listener(repoFullName, collapsed);
}

export function subscribeRepoCollapse(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyRepoCollapseState(groups) {
  for (const group of groups) {
    if (repoCollapseQueues.has(group.full_name)) continue;
    if (group.collapsed) confirmedCollapsedRepos.add(group.full_name);
    else confirmedCollapsedRepos.delete(group.full_name);
  }
  return groups.map((group) => ({
    ...group,
    collapsed: collapsedState(group.full_name),
  }));
}

export async function loadRepoCollapseState() {
  const collapsedRepos = await invoke("list_collapsed_repos");
  const persisted = new Set(collapsedRepos);
  for (const repoFullName of [...confirmedCollapsedRepos]) {
    if (!repoCollapseQueues.has(repoFullName) && !persisted.has(repoFullName)) {
      confirmedCollapsedRepos.delete(repoFullName);
    }
  }
  for (const repoFullName of persisted) {
    if (!repoCollapseQueues.has(repoFullName)) confirmedCollapsedRepos.add(repoFullName);
  }
  return collapsedRepoNames();
}

export function isRepoCollapsed(repoFullName) {
  return collapsedState(repoFullName);
}

export function collapsedRepoNames() {
  const names = new Set(confirmedCollapsedRepos);
  for (const [repoFullName, collapsed] of pendingCollapsedRepos) {
    if (collapsed) names.add(repoFullName);
    else names.delete(repoFullName);
  }
  return names;
}

export function setRepoCollapsed(repoFullName, collapsed) {
  const seq = ++collapseSeq;
  latestCollapseSeq.set(repoFullName, seq);
  pendingCollapsedRepos.set(repoFullName, collapsed);
  notify(repoFullName, collapsed);

  const previous = repoCollapseQueues.get(repoFullName) ?? Promise.resolve();
  const request = previous
    .catch(() => {})
    .then(() =>
      invoke("set_notification_repo_collapsed", {
        repoFullName,
        collapsed,
      }),
    );
  repoCollapseQueues.set(repoFullName, request);

  return request
    .then(() => {
      if (collapsed) confirmedCollapsedRepos.add(repoFullName);
      else confirmedCollapsedRepos.delete(repoFullName);
      const latest = latestCollapseSeq.get(repoFullName) === seq;
      if (latest) pendingCollapsedRepos.delete(repoFullName);
      return { collapsed, latest };
    })
    .catch((error) => {
      const latest = latestCollapseSeq.get(repoFullName) === seq;
      if (latest) {
        pendingCollapsedRepos.delete(repoFullName);
        notify(repoFullName, confirmedCollapsedRepos.has(repoFullName));
      }
      throw { error, latest };
    })
    .finally(() => {
      if (repoCollapseQueues.get(repoFullName) === request) {
        repoCollapseQueues.delete(repoFullName);
      }
    });
}
