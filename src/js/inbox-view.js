import { html, rawHtml } from "./dom.js";
import { relTime } from "./format.js";
import { authorTag, pill, iconButton } from "./ui.js";
import { TYPE_FILTERS, isAwaitingState } from "./inbox-model.js";

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

/** Map a PR's rolled-up `mergeable_state` to a merge-readiness pill. Only meaningful for an
 *  **open** pull request (a merged/closed PR's mergeability is moot), so returns "" for any
 *  other subject type/state, and for `unknown`/null (GitHub computes it lazily). The single
 *  `mergeable_state` field already folds in required checks + reviews, so no extra API call
 *  is needed — it rides along on the PR resolution Helix already does. */
export function mergeStateBadge(mergeableState, subjectType, subjectState) {
  if (subjectType !== "PullRequest" || subjectState !== "open") return "";
  const map = {
    clean: ["Ready", "merge--clean"],
    has_hooks: ["Ready", "merge--clean"],
    unstable: ["Checks failing", "merge--unstable"],
    blocked: ["Blocked", "merge--blocked"],
    dirty: ["Conflicts", "merge--dirty"],
    behind: ["Behind", "merge--behind"],
    draft: ["Draft", "merge--draft"],
  };
  const entry = map[mergeableState];
  if (!entry) return "";
  const [label, cls] = entry;
  return pill(label, `merge ${cls}`);
}

/** Checkmark glyph for the "mark as done" affordances (row / toolbar / repo header). */
const DONE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 8.5l3 3 6.2-6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Bookmark glyph: hollow when not bookmarked, filled when bookmarked. */
const BOOKMARK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h8v11l-4-3-4 3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const BOOKMARK_ICON_FILLED = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5h8v11l-4-3-4 3z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const COLLAPSE_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function notificationRow(n) {
  const number =
    n.subject_number != null ? html`<span class="n-number">#${n.subject_number}</span> ` : "";
  const badge = stateBadge(n.subject_state);
  const merge = mergeStateBadge(n.subject_mergeable_state, n.subject_type, n.subject_state);
  const stateLine =
    badge || merge ? html`<div class="n-state">${rawHtml(badge)}${rawHtml(merge)}</div>` : "";
  // Only rows with a resolved web URL are openable (clickable + hover affordance).
  const url = n.subject_html_url || "";
  const isNew = n.is_new ? " n-row--new" : "";
  const author = n.subject_author ? authorTag(n.subject_author) : "";
  const bookmarked = !!n.bookmarked;
  const done = !!n.is_done;
  // A PR/Issue whose state hasn't resolved yet gets a subtle striped cue (unless it's done).
  const awaiting = !done && isAwaitingState(n) ? " n-row--awaiting" : "";
  const cls = `n-row${url ? " n-row--openable" : ""}${isNew}${awaiting}${bookmarked ? " n-row--bookmarked" : ""}${done ? " n-row--done" : ""}`;
  const openAttrs = url ? html` data-url="${url}" role="link" tabindex="0"` : "";
  // A done thread (only ever shown in Bookmarks) has no mark-as-done button; render an inert
  // spacer (NOT an .n-done, so it never reveals on hover or handles clicks) to keep the
  // bookmark icon aligned with active rows.
  const doneBtn = done
    ? html`<span class="n-done-spacer" aria-hidden="true"></span>`
    : iconButton({
        icon: DONE_ICON,
        className: "n-done",
        title: "Mark as done",
        label: `Mark "${n.subject_title}" as done`,
      });
  const bookmarkBtn = iconButton({
    icon: bookmarked ? BOOKMARK_ICON_FILLED : BOOKMARK_ICON,
    className: `n-bookmark${bookmarked ? " is-on" : ""}`,
    title: bookmarked ? "Remove bookmark" : "Bookmark",
    label: `${bookmarked ? "Remove bookmark from" : "Bookmark"} "${n.subject_title}"`,
    attrs: html`aria-pressed="${bookmarked ? "true" : "false"}"`,
  });
  return html`
    <li class="${cls}" data-thread-id="${n.thread_id}"${rawHtml(done ? ' data-done="true"' : "")}>
      <div class="n-open"${rawHtml(openAttrs)}>
        <span class="n-badge-slot">${rawHtml(subjectBadge(n.subject_type))}</span>
        <div class="n-main">
          <div class="n-title">${rawHtml(number)}${n.subject_title}</div>
          ${rawHtml(stateLine)}
          <div class="n-meta"><span class="n-reason">${n.reason.replace(/_/g, " ")}</span> · ${relTime(n.updated_at)}</div>
        </div>
        ${rawHtml(author)}
      </div>
      ${rawHtml(bookmarkBtn)}
      ${rawHtml(doneBtn)}
    </li>`;
}

export function repoHeader(group) {
  const collapsed = Boolean(group.collapsed);
  const listId = `repo-list-${group.repo_id}`;
  const collapse = iconButton({
    icon: COLLAPSE_ICON,
    className: "repo-collapse",
    title: collapsed ? "Expand repository notifications" : "Collapse repository notifications",
    label: `${collapsed ? "Expand" : "Collapse"} ${group.full_name} notifications`,
    attrs: html`data-collapse-repo="${group.repo_id}" data-repo-full-name="${group.full_name}" aria-expanded="${!collapsed}" aria-controls="${listId}"`,
  });
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
    attrs: html`data-done-repo="${group.repo_id}"`,
  });
  // The repo name is an <h2> so screen-reader users can navigate the inbox by heading; it
  // also names the group region (see `repoSection`).
  return html`
    <div class="repo-header">
      ${rawHtml(collapse)}
      <h2 class="repo-name" id="repo-h-${group.repo_id}">${group.full_name}</h2>
      ${rawHtml(privacy)}
      ${rawHtml(counts)}
      ${rawHtml(clear)}
    </div>`;
}

export function repoSection(group) {
  const collapsed = Boolean(group.collapsed);
  const rows = collapsed ? "" : group.notifications.map(notificationRow).join("");
  const hidden = collapsed ? rawHtml(" hidden") : "";
  const collapsedClass = collapsed ? " repo-section--collapsed" : "";
  // `role=group` + `aria-labelledby` ties the list to its repo heading for assistive tech
  // without creating a landmark per repo (which would be noisy with many repos).
  return html`<section class="repo-section${collapsedClass}" role="group" aria-labelledby="repo-h-${group.repo_id}">${rawHtml(
    repoHeader(group),
  )}<ul class="n-list" id="repo-list-${group.repo_id}"${hidden}>${rawHtml(rows)}</ul></section>`;
}

/** The top-of-view subject-type filter: a leading "Showing:" label plus a single line of
 *  toggle pills (Pull requests / Issues / Other) rendered from `TYPE_FILTERS`.
 *  `selectedTypes` is a Set of bucket ids; a selected pill gets `aria-pressed="true"` +
 *  `.is-on`. The pills are wrapped in a labeled `role="group"` so assistive tech announces
 *  them as one control (the visible label is `aria-hidden`, redundant with that group
 *  label). Stateless — `inbox.js` owns the Set and re-renders on toggle. */
export function typeFilterBar(selectedTypes) {
  const pills = TYPE_FILTERS.map(({ id, label }) => {
    const on = selectedTypes.has(id);
    return html`<button type="button" class="type-pill${on ? " is-on" : ""}" data-type="${id}" aria-pressed="${on ? "true" : "false"}">${label}</button>`;
  }).join("");
  return html`<span class="type-filter-label" aria-hidden="true">Showing:</span><div class="type-filter-inner" role="group" aria-label="Filter by subject type">${rawHtml(
    pills,
  )}</div>`;
}
