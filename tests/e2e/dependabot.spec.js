import { test, expect } from "@playwright/test";
import { openApp, defaultFixtures } from "./tauri-mock.js";

/* The read-only Dependabot module: it lists open Dependabot PRs grouped by repository with a
 * repo-only sidebar and a merge-readiness pill, opens a PR in the browser, and has NO
 * bookmark / mark-done affordances. Backed by the mocked `list_dependabot` / `sync_dependabot`. */

/** Open the app and switch to the Dependabot module, waiting for its list to render. */
async function openDependabot(page, fixtures = defaultFixtures()) {
  await openApp(page, fixtures);
  await page.locator('.module-tab[data-module="dependabot"]').click();
  await page.waitForSelector("#dependabot .repo-section, #dependabot .inbox-empty");
}

test("lists open Dependabot PRs grouped by repository", async ({ page }) => {
  await openDependabot(page);

  // Two repos from the fixture, most-recent-first (acme/widgets has the newest PR).
  const repoNames = page.locator("#dependabot .repo-section .repo-name");
  await expect(repoNames).toHaveText(["acme/widgets", "octo/hello"]);

  // All three fixture PRs are shown as openable rows.
  await expect(page.locator("#dependabot .n-row")).toHaveCount(3);
  await expect(page.locator("#dependabot")).toContainText("Bump lodash from 4.17.20 to 4.17.21");
});

test("shows merge readiness and a merge action without notification controls", async ({ page }) => {
  await openDependabot(page);

  // clean → "Ready", blocked → "Blocked" (from the fixture's mergeable_state values).
  await expect(page.locator("#dependabot .merge--clean")).toHaveCount(1);
  await expect(page.locator("#dependabot .merge--blocked")).toHaveCount(1);

  // Dependabot owns its own merge action, not notification controls.
  await expect(page.locator("#dependabot .dep-merge-action")).toHaveCount(3);
  await expect(page.locator("#dependabot .n-bookmark")).toHaveCount(0);
  await expect(page.locator("#dependabot .n-done")).toHaveCount(0);
  await expect(page.locator("#view-dependabot #mark-all-done-btn")).toHaveCount(0);
});

test("queues a merge and shows it in Operations", async ({ page }) => {
  await openDependabot(page);

  const row = page.locator('#dependabot .n-row[data-pr-id="101"]');
  await row.hover();
  await row.locator(".dep-merge-action").click();
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  await expect(page.locator("#dependabot .operation-row")).toHaveCount(1);
  await expect(page.locator("#dependabot .operation-row")).toContainText("Bump lodash");
  await expect(page.locator("#dependabot .operation-row")).toContainText(/Queued|Merging/);

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "enqueue_dependabot_merge")).toBe(true);
});

test("cancels an active merge from Operations", async ({ page }) => {
  const operation = {
    id: 17,
    pr_id: 101,
    repo_full_name: "octo/hello",
    number: 40,
    title: "Bump lodash",
    html_url: "https://github.com/octo/hello/pull/40",
    state: "delegated",
    queue_position: 1,
    failure_reason: null,
    last_error: null,
    enqueued_at: "2026-06-27T10:00:00Z",
    delegated_at: "2026-06-27T10:01:00Z",
    terminal_at: null,
  };
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  await page.locator("#dependabot .dep-operation-cancel").click();

  await expect(page.locator("#dependabot .operation-row")).toContainText(/Cancelling|Cancelled/);
  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "cancel_dependabot_merge")).toBe(true);
});

test("preserves operation control focus across live refreshes", async ({ page }) => {
  const operation = {
    id: 18,
    pr_id: 101,
    repo_full_name: "octo/hello",
    number: 40,
    title: "Bump lodash",
    html_url: "https://github.com/octo/hello/pull/40",
    state: "delegated",
    queue_position: 1,
    failure_reason: null,
    last_error: null,
    enqueued_at: "2026-06-27T10:00:00Z",
    delegated_at: "2026-06-27T10:01:00Z",
    terminal_at: null,
  };
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  const cancel = page.locator(
    '#dependabot .operation-row[data-operation-id="18"] .dep-operation-cancel',
  );
  await cancel.focus();
  await page.evaluate(() => window.__mockEmit("dependabot:operations-changed", null));

  await expect(cancel).toBeFocused();
});

test("preserves PR merge-action focus across live refreshes", async ({ page }) => {
  await openDependabot(page);
  const action = page.locator('#dependabot .n-row[data-pr-id="101"] .dep-merge-action');
  await action.focus();
  await page.evaluate(() => window.__mockEmit("dependabot:operations-changed", null));

  await expect(action).toBeFocused();
});

test("the sidebar lists repositories and refines the list", async ({ page }) => {
  await openDependabot(page);

  // "All" shows the total open PR count and is active by default.
  const all = page.locator('#dependabot-filter-list [data-filter="all"]');
  await expect(all).toHaveAttribute("aria-current", "true");
  await expect(all.locator(".source-count")).toHaveText("3");

  const repoSources = page.locator("#dependabot-repo-list .repo-source");
  await expect(repoSources).toHaveCount(2);

  // Refine to octo/hello → only its two PRs remain.
  await page.locator('#dependabot-repo-list .repo-source[data-repo="octo/hello"]').click();
  await expect(page.locator("#dependabot .repo-section")).toHaveCount(1);
  await expect(page.locator("#dependabot .repo-name")).toHaveText("octo/hello");
  await expect(page.locator("#dependabot .n-row")).toHaveCount(2);
  await expect(
    page.locator('#dependabot-repo-list .repo-source[data-repo="octo/hello"]'),
  ).toHaveAttribute("aria-current", "true");
  // Refining a repo moves the active highlight off "All".
  await expect(all).not.toHaveAttribute("aria-current", "true");

  // Clicking "All" clears the refinement → both repos back and "All" active again.
  await all.click();
  await expect(page.locator("#dependabot .repo-section")).toHaveCount(2);
  await expect(all).toHaveAttribute("aria-current", "true");

  // Toggling a repo off (clicking it twice) also returns to the full list.
  await page.locator('#dependabot-repo-list .repo-source[data-repo="octo/hello"]').click();
  await page.locator('#dependabot-repo-list .repo-source[data-repo="octo/hello"]').click();
  await expect(page.locator("#dependabot .repo-section")).toHaveCount(2);
});

test("activating a PR row opens it in the browser via open_url", async ({ page }) => {
  await openDependabot(page);

  await page.locator('#dependabot .n-row[data-pr-id="103"] .n-open').click();

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  const opened = calls.find((c) => c.cmd === "open_url");
  expect(opened, "open_url should have been invoked").toBeTruthy();
  expect(opened.args.url).toBe("https://github.com/acme/widgets/pull/9");
});

test("auto-syncs on first open (calls sync_dependabot)", async ({ page }) => {
  await openDependabot(page);

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((c) => c.cmd === "sync_dependabot")).toBe(true);
});

test("empty state when there are no Dependabot PRs", async ({ page }) => {
  await openDependabot(page, { ...defaultFixtures(), dependabot: [] });

  await expect(page.locator("#dependabot .inbox-empty")).toBeVisible();
  await expect(page.locator("#dependabot")).toContainText("No open Dependabot pull requests");
  await expect(page.locator("#dependabot-repo-list .source-empty")).toBeVisible();
});

/* ---------------------------------------------------------------------------------------
 * Phase 2: the operation-detail disclosure, its compact flow graph, node selection, live
 * refresh, focus/scroll preservation across whole-list rerenders, and escaping. Backed by the
 * mocked `get_dependabot_merge_operation_detail`, `window.__mockSetOperation` (patch an
 * operation + its stored detail, then fire the live `dependabot:operations-changed` event),
 * and `window.__mockResolvePendingDetail` (resolve a deferred detail fetch on demand, for the
 * stale-response defense).
 * --------------------------------------------------------------------------------------- */

/** A merge operation with sensible Phase 2 defaults (delegated, mid-flight, direct strategy);
 *  override whatever a given test cares about. */
function mergeOperation(overrides = {}) {
  return {
    id: 50,
    pr_id: 101,
    repo_full_name: "octo/hello",
    number: 40,
    title: "Bump lodash",
    html_url: "https://github.com/octo/hello/pull/40",
    state: "delegated",
    phase: "waiting_checks",
    strategy: "direct",
    queue_position: null,
    check_retry_count: 0,
    merge_queue_position: null,
    failure_reason: null,
    last_error: null,
    enqueued_at: "2026-06-27T10:00:00Z",
    delegated_at: "2026-06-27T10:01:00Z",
    terminal_at: null,
    ...overrides,
  };
}

/** Switch to Operations and expand the (single) operation row's disclosure. */
async function expandOperation(page, operationId) {
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  await page
    .locator(
      `#dependabot .operation-row[data-operation-id="${operationId}"] .dep-operation-disclosure`,
    )
    .click();
}

test("expanding an operation shows a loading state, then the fetched flow-graph detail", async ({
  page,
}) => {
  const operation = mergeOperation();
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [operation],
    deferDetailResolution: true,
  });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  const disclosure = page.locator("#dependabot .dep-operation-disclosure");
  await disclosure.click();

  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#dependabot .op-panel-loading")).toContainText(
    "Loading operation timeline",
  );
  await expect(page.locator("#dependabot .op-flow")).toHaveCount(0);

  await page.evaluate(() => window.__mockResolvePendingDetail());

  await expect(page.locator("#dependabot .op-panel-loading")).toHaveCount(0);
  await expect(page.locator("#dependabot .op-flow")).toBeVisible();
  await expect(page.locator("#dependabot .op-step[aria-current='step'] .op-node")).toHaveCount(1);
  await expect(page.locator("#dependabot .op-log-message")).toContainText(
    "Merge operation queued.",
  );

  // Collapsing removes the whole panel and returns the disclosure to its resting state.
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#dependabot .op-panel-row")).toHaveCount(0);
});

test("renders the direct-merge strategy flow graph with the current step highlighted", async ({
  page,
}) => {
  const operation = mergeOperation({ strategy: "direct", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await expandOperation(page, operation.id);

  await expect(page.locator("#dependabot .op-flow-marker")).toHaveText("Direct merge");
  await expect(page.locator('#dependabot .op-node[data-node-id="merging"]')).toHaveCount(1);
  await expect(
    page.locator('#dependabot .op-node[data-node-id="enabling_auto_merge"]'),
  ).toHaveCount(0);

  const current = page.locator('#dependabot .op-step[aria-current="step"] .op-node');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-node-id", "waiting_checks");
});

test("renders the merge-queue strategy flow graph with the current step highlighted", async ({
  page,
}) => {
  const operation = mergeOperation({ strategy: "merge_queue", phase: "waiting_merge_queue" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await expandOperation(page, operation.id);

  await expect(page.locator("#dependabot .op-flow-marker")).toHaveText("Merge queue");
  await expect(
    page.locator('#dependabot .op-node[data-node-id="waiting_merge_queue"]'),
  ).toHaveCount(1);
  await expect(page.locator('#dependabot .op-node[data-node-id="merging"]')).toHaveCount(1);

  const current = page.locator('#dependabot .op-step[aria-current="step"] .op-node');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-node-id", "waiting_merge_queue");
});

test("flow-graph nodes are read-only", async ({ page }) => {
  const operation = mergeOperation({ strategy: "direct", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await expandOperation(page, operation.id);

  const nodes = page.locator("#dependabot .op-node");
  await expect(nodes.first()).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#dependabot .op-node button")).toHaveCount(0);
  await expect(page.locator("#dependabot .op-node[tabindex]")).toHaveCount(0);
});

test("Enter on the disclosure button does not open the PR", async ({ page }) => {
  const operation = mergeOperation({ strategy: "direct", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  const disclosure = page.locator("#dependabot .dep-operation-disclosure");
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((c) => c.cmd === "open_url")).toBe(false);
});

test("shows retry count from check_retry_count and distinguishes Helix's queue position from GitHub's", async ({
  page,
}) => {
  const retrying = mergeOperation({
    id: 51,
    state: "delegated",
    phase: "retrying_checks",
    strategy: "direct",
    check_retry_count: 2,
  });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [retrying] });
  await expandOperation(page, retrying.id);
  await expect(page.locator("#dependabot .op-meta")).toContainText("Retry 2");

  // A separate operation waiting behind another in Helix's own FIFO (Helix `queue_position`)
  // vs. one already admitted to GitHub's native merge queue (`merge_queue_position`) — the
  // two must render distinctly, never conflated. `delegatedHead` occupies the repo's single
  // active slot so the mock's own processing tick (fired when the module opens) doesn't
  // auto-advance `waitingHelix` out of "queued" before we can assert its position.
  const delegatedHead = mergeOperation({ id: 55, state: "delegated", phase: "waiting_checks" });
  const waitingHelix = mergeOperation({
    id: 52,
    state: "queued",
    phase: "queued",
    strategy: "unknown",
    queue_position: 2,
  });
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [delegatedHead, waitingHelix],
  });
  await expandOperation(page, waitingHelix.id);
  await expect(page.locator("#dependabot .op-meta")).toContainText("Queue position 2");

  const waitingGithub = mergeOperation({
    id: 53,
    state: "delegated",
    phase: "waiting_merge_queue",
    strategy: "merge_queue",
    merge_queue_position: 4,
  });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [waitingGithub] });
  await expandOperation(page, waitingGithub.id);
  await expect(page.locator("#dependabot .op-meta")).toContainText("GitHub queue position 4");
});

test("a live operation-change event refreshes the expanded detail in place", async ({ page }) => {
  const operation = mergeOperation({ phase: "waiting_checks", strategy: "direct" });
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [operation],
    mergeOperationDetails: {
      [operation.id]: {
        operation,
        events: [{ timestamp: "2026-06-27T10:01:00Z", message: "Waiting on checks." }],
        current_explanation: "Waiting for required status checks to finish.",
        next_action: "Continue toward merging once checks succeed.",
      },
    },
  });
  await expandOperation(page, operation.id);
  await expect(page.locator("#dependabot .op-explanation--current")).toContainText(
    "Waiting for required status checks to finish.",
  );
  await expect(page.locator('#dependabot .op-step[aria-current="step"] .op-node')).toHaveAttribute(
    "data-node-id",
    "waiting_checks",
  );

  await page.evaluate(
    (id) =>
      window.__mockSetOperation(
        id,
        { phase: "merging" },
        {
          current_explanation: "Merging the pull request.",
          next_action: "No further action — Helix is completing the merge.",
          events: [
            { timestamp: "2026-06-27T10:01:00Z", message: "Waiting on checks." },
            { timestamp: "2026-06-27T10:05:00Z", message: "Checks passed." },
          ],
        },
      ),
    operation.id,
  );

  await expect(page.locator("#dependabot .op-explanation--current")).toContainText(
    "Merging the pull request.",
  );
  await expect(page.locator('#dependabot .op-step[aria-current="step"] .op-node')).toHaveAttribute(
    "data-node-id",
    "merging",
  );
  await expect(page.locator("#dependabot .op-log-item")).toHaveCount(2);
});

test("a stale detail response does not overwrite a newer one", async ({ page }) => {
  const opA = mergeOperation({
    id: 60,
    repo_full_name: "octo/hello",
    phase: "waiting_checks",
    strategy: "direct",
  });
  const opB = mergeOperation({
    id: 61,
    repo_full_name: "acme/widgets",
    number: 9,
    title: "Bump serde",
    html_url: "https://github.com/acme/widgets/pull/9",
    phase: "enabling_auto_merge",
    strategy: "merge_queue",
  });
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [opA, opB],
    deferDetailResolution: true,
  });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  // Expand A: its detail fetch is call #0, held pending.
  await page
    .locator(`#dependabot .operation-row[data-operation-id="${opA.id}"] .dep-operation-disclosure`)
    .click();
  expect(await page.evaluate(() => window.__mockPendingDetailCount())).toBe(1);

  // Switch to B before A's fetch resolves: only one operation is ever expanded at a time, so
  // this both collapses A and fires B's own fetch (call #1, also held pending).
  await page
    .locator(`#dependabot .operation-row[data-operation-id="${opB.id}"] .dep-operation-disclosure`)
    .click();
  expect(await page.evaluate(() => window.__mockPendingDetailCount())).toBe(2);
  await expect(page.locator("#dependabot .op-panel-loading")).toHaveCount(1);

  // Resolve A's now-stale response (call #0) — it must not render anywhere: B's row is the
  // only one expanded, and it must still show its own loading placeholder, not A's content.
  await page.evaluate(() => window.__mockResolvePendingDetail(0));
  await expect(page.locator("#dependabot .op-flow-marker")).toHaveCount(0);
  await expect(page.locator("#dependabot .op-panel-loading")).toHaveCount(1);
  await expect(
    page.locator(`#dependabot .op-panel-row[data-operation-id="${opA.id}"]`),
  ).toHaveCount(0);

  // Resolve B's response (now the only pending call) — it renders normally.
  await page.evaluate(() => window.__mockResolvePendingDetail(0));
  await expect(page.locator("#dependabot .op-flow-marker")).toHaveText("Merge queue");
  await expect(
    page.locator(`#dependabot .op-panel-row[data-operation-id="${opB.id}"]`),
  ).toBeVisible();
});

test("cancelling an operation while its detail is expanded keeps the panel in sync", async ({
  page,
}) => {
  const operation = mergeOperation({
    state: "delegated",
    phase: "waiting_checks",
    strategy: "direct",
  });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await expandOperation(page, operation.id);
  await expect(page.locator("#dependabot .op-flow")).toBeVisible();

  await page.locator("#dependabot .dep-operation-cancel").click();

  await expect(page.locator("#dependabot .operation-row")).toContainText(/Cancelling|Cancelled/);
  // The panel stays open throughout (it's a distinct control from the row-level cancel/PR
  // link) and, once the cancellation lands, its terminal step reflects the new outcome.
  await expect(page.locator("#dependabot .dep-operation-disclosure")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(page.locator('#dependabot .op-node[data-node-id="terminal"]')).toContainText(
    "Cancelled",
  );
  await expect(page.locator("#dependabot .dep-operation-cancel")).toHaveCount(0);
});

test("preserves the disclosure button's focus across a live refresh", async ({ page }) => {
  const operation = mergeOperation({ phase: "waiting_checks", strategy: "direct" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  const disclosure = page.locator("#dependabot .dep-operation-disclosure");
  await disclosure.focus();
  await page.evaluate(() => window.__mockEmit("dependabot:operations-changed", null));
  await expect(disclosure).toBeFocused();
});

test("preserves scroll position across a live whole-list rerender", async ({ page }) => {
  const operations = Array.from({ length: 30 }, (_, i) =>
    mergeOperation({
      id: 100 + i,
      number: 100 + i,
      title: `Bump dep ${i}`,
      state: "merged",
      phase: "merging",
      strategy: "direct",
      terminal_at: `2026-06-27T10:${String(i).padStart(2, "0")}:00Z`,
    }),
  );
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: operations });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  await page.locator("#dependabot").evaluate((el) => (el.scrollTop = 400));
  const before = await page.locator("#dependabot").evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);

  await page.evaluate(() => window.__mockEmit("dependabot:operations-changed", null));

  const after = await page.locator("#dependabot").evaluate((el) => el.scrollTop);
  expect(after).toBe(before);
});

test("expanded detail escapes untrusted explanation/next-action/event content", async ({
  page,
}) => {
  const operation = mergeOperation();
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [operation],
    mergeOperationDetails: {
      [operation.id]: {
        operation,
        events: [
          {
            timestamp: "2026-06-27T10:01:00Z",
            message: "<img src=x onerror=alert(1)>",
            detail: "<b>bold</b> detail",
          },
        ],
        current_explanation: "<script>evil()</script>",
        next_action: "Also <b>bold</b> next action",
      },
    },
  });
  await expandOperation(page, operation.id);

  await expect(page.locator("#dependabot .op-explanation--current")).toContainText("evil()");
  const html = await page.locator("#dependabot").innerHTML();
  expect(html).not.toContain("<script>evil()");
  expect(html).not.toContain("<img src=x onerror");
  expect(html).not.toContain("<b>bold</b>");
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
});
