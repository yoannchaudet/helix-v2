import { escapeHtml } from "./dom.js";
import { relTime } from "./format.js";
import { pill, iconButton } from "./ui.js";

/* Pure HTML templating for the inbox: given a notification (or repo group), return the
 * markup string. No DOM access, no module state — so these are unit-testable and the
 * stateful controller (`inbox.js`) owns all wiring/rendering side effects. */

const SUBJECT_BADGES = {
  PullRequest: ["PR", "badge--pr"],
  Issue: ["Issue", "badge--issue"],
  Discussion: ["Discussion", "badge--other"],
  Release: ["Release", "badge--other"],
  Commit: ["Commit", "badge--other"],
  AgentSessionThread: ["Copilot", "badge--other"],
  CheckSuite: ["Check", "badge--other"],
  RepositoryVulnerabilityAlert: ["Alert", "badge--alert"],
  RepositoryInvitation: ["Invite", "badge--other"],
};

export function subjectBadge(type) {
  const [label, cls] = SUBJECT_BADGES[type] ?? [type, "badge--other"];
  return pill(label, `badge ${cls}`);
}

/** Map a resolved subject state to a display pill. `subject_state` is only ever
 *  `open` / `closed` / `merged` (the backend folds a merged PR into `merged`; issue
 *  `state_reason` like completed/not_planned lives in a separate column and isn't shown).
 *  Returns "" for unresolved or non-PR/Issue subjects, so no pill is shown. */
export function stateBadge(state) {
  const map = {
    open: ["Open", "state--open"],
    closed: ["Closed", "state--closed"],
    merged: ["Merged", "state--merged"],
  };
  const entry = map[state];
  if (!entry) return "";
  const [label, cls] = entry;
  return pill(label, `state ${cls}`);
}

/** Checkmark glyph for the "mark as done" affordances (row / toolbar / repo header). */
const DONE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 8.5l3 3 6.2-6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function notificationRow(n) {
  const number =
    n.subject_number != null
      ? `<span class="n-number">#${escapeHtml(n.subject_number)}</span> `
      : "";
  const badge = stateBadge(n.subject_state);
  const stateLine = badge ? `<div class="n-state">${badge}</div>` : "";
  const reason = escapeHtml(n.reason.replace(/_/g, " "));
  // Only rows with a resolved web URL are openable (clickable + hover affordance).
  const url = n.subject_html_url || "";
  const cls = `n-row${url ? " n-row--openable" : ""}`;
  const openAttrs = url
    ? ` data-url="${escapeHtml(url)}" role="link" tabindex="0"`
    : "";
  // Contextual accessible name so each row's button isn't an indistinct "Mark as done".
  const doneBtn = iconButton({
    icon: DONE_ICON,
    className: "n-done",
    title: "Mark as done",
    label: `Mark "${n.subject_title}" as done`,
  });
  return `
    <li class="${cls}" data-thread-id="${escapeHtml(n.thread_id)}">
      <div class="n-open"${openAttrs}>
        <span class="n-badge-slot">${subjectBadge(n.subject_type)}</span>
        <div class="n-main">
          <div class="n-title">${number}${escapeHtml(n.subject_title)}</div>
          ${stateLine}
          <div class="n-meta"><span class="n-reason">${reason}</span> · ${escapeHtml(relTime(n.updated_at))}</div>
        </div>
      </div>
      ${doneBtn}
    </li>`;
}

export function repoHeader(group) {
  const privacy = group.private
    ? pill("private", "badge badge--lock", { title: "Private repository" })
    : "";
  // Read state isn't tracked; show how many notifications are shown for this repo (i.e.
  // matching the active filter — `group.notifications` is already filtered upstream).
  const counts = `<span class="repo-counts">${group.notifications.length}</span>`;
  // A natural sub-filter: clear just this repo's (filtered) notifications.
  const clear = iconButton({
    icon: DONE_ICON,
    className: "repo-done",
    title: "Mark this repo's notifications as done",
    label: `Mark ${group.full_name} notifications as done`,
    attrs: `data-done-repo="${group.repo_id}"`,
  });
  // The repo name is an <h2> so screen-reader users can navigate the inbox by heading; it
  // also names the group region (see `repoSection`).
  return `
    <div class="repo-header">
      <h2 class="repo-name" id="repo-h-${group.repo_id}">${escapeHtml(group.full_name)}</h2>
      ${privacy}
      ${counts}
      ${clear}
    </div>`;
}

export function repoSection(group) {
  const rows = group.notifications.map(notificationRow).join("");
  // `role=group` + `aria-labelledby` ties the list to its repo heading for assistive tech
  // without creating a landmark per repo (which would be noisy with many repos).
  return `<section class="repo-section" role="group" aria-labelledby="repo-h-${group.repo_id}">${repoHeader(
    group,
  )}<ul class="n-list">${rows}</ul></section>`;
}
