/* Pure HTML templating for the Dependabot module: given a PR (or repo group), return the
 * markup string. No DOM access, no module state — so these are unit-testable and the
 * stateful controller (`dependabot.js`) owns all wiring/rendering. Reuses the shared row
 * building blocks (`authorTag`, `mergeStateBadge`, `pill`) so a Dependabot PR row reads like
 * a notification row, minus the bookmark/done affordances. */

import { html, rawHtml } from "./dom.js";
import { relTime } from "./format.js";
import { pill } from "./ui.js";
import { authorTag, mergeStateBadge } from "./inbox-view.js";
import { repoDomId } from "./dependabot-model.js";

/** Static "PR" subject badge — every row here is a pull request. */
const PR_BADGE = pill("PR", "badge badge--pr");

/** One Dependabot PR as an openable row. Activating it opens `html_url` in the browser
 *  (wired by the controller). The merge-readiness pill reuses `mergeStateBadge` with a fixed
 *  PullRequest/open context (the module only ever lists open PRs). */
export function prRow(pr) {
  const number = html`<span class="n-number">#${pr.number}</span> `;
  const merge = mergeStateBadge(pr.mergeable_state, "PullRequest", "open");
  const stateLine = merge ? html`<div class="n-state">${rawHtml(merge)}</div>` : "";
  const author = pr.author ? authorTag(pr.author) : "";
  return html`
    <li class="n-row n-row--openable" data-pr-id="${pr.id}">
      <div class="n-open" data-url="${pr.html_url}" role="link" tabindex="0">
        <span class="n-badge-slot">${rawHtml(PR_BADGE)}</span>
        <div class="n-main">
          <div class="n-title">${rawHtml(number)}${pr.title}</div>
          ${rawHtml(stateLine)}
          <div class="n-meta">${relTime(pr.updated_at)}</div>
        </div>
        ${rawHtml(author)}
      </div>
    </li>`;
}

/** Repo section header: the repository name (an `<h2>` so screen-reader users can navigate
 *  by heading) plus a count of its open Dependabot PRs. No mark-done affordance (read-only). */
export function repoHeader(group) {
  const counts = `<span class="repo-counts">${group.prs.length}</span>`;
  return html`
    <div class="repo-header">
      <h2 class="repo-name" id="${repoDomId(group.full_name)}">${group.full_name}</h2>
      ${rawHtml(counts)}
    </div>`;
}

/** A repository's PRs as a labeled group region (mirrors the inbox `repoSection`). */
export function repoSection(group) {
  const rows = group.prs.map(prRow).join("");
  return html`<section class="repo-section" role="group" aria-labelledby="${repoDomId(
    group.full_name,
  )}">${rawHtml(repoHeader(group))}<ul class="n-list">${rawHtml(rows)}</ul></section>`;
}
