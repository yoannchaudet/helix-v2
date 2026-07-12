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
  await expect(page.locator('#dependabot .n-row[data-pr-id="101"]')).toContainText("Target: main");
  await expect(page.locator('#dependabot .n-row[data-pr-id="102"]')).toContainText(
    "Target: release/v2",
  );
});

test("Dependabot view is exposed as a named region", async ({ page }) => {
  await openDependabot(page);

  await expect(page.locator("#view-dependabot")).toHaveAttribute(
    "aria-labelledby",
    "dependabot-view-title",
  );
  await expect(page.getByRole("region", { name: "Dependabot" })).toHaveAttribute(
    "id",
    "view-dependabot",
  );
});

test("shows merge readiness and a merge action without notification controls", async ({ page }) => {
  await openDependabot(page);

  // clean → "Ready", blocked → "Blocked" (from the fixture's mergeable_state values).
  await expect(page.locator("#dependabot .merge--clean")).toHaveCount(1);
  await expect(page.locator("#dependabot .merge--blocked")).toHaveCount(1);

  // Dependabot owns its own merge action, not notification controls.
  await expect(page.locator("#dependabot .dep-merge-action")).toHaveCount(3);
  await expect(page.locator("#dependabot .dep-discard-action")).toHaveCount(3);
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
  await expect(page.locator("#dependabot .operation-row")).toContainText("Target: main");

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "enqueue_dependabot_merge")).toBe(true);
});

test("confirms a direct discard, closes the PR, and leaves notifications unchanged", async ({
  page,
}) => {
  await openDependabot(page);
  const before = await page.evaluate(() => window.__TAURI__.core.invoke("list_inbox"));
  const row = page.locator('#dependabot .n-row[data-pr-id="101"]');
  await row.hover();
  await row.locator(".dep-discard-action").click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await expect(row).toHaveCount(1);
  let calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "discard_dependabot_pr")).toBe(false);

  await row.hover();
  await row.locator(".dep-discard-action").click();
  await page.getByRole("menuitem", { name: /Confirm: discard and close/ }).click();
  await expect(row).toHaveCount(0);

  const after = await page.evaluate(() => window.__TAURI__.core.invoke("list_inbox"));
  expect(after).toEqual(before);
  calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "discard_dependabot_pr")).toBe(true);
  expect(calls.some((call) => call.cmd === "mark_threads_done")).toBe(false);
});

test("keeps the PR visible when GitHub rejects a discard", async ({ page }) => {
  await openDependabot(page, {
    ...defaultFixtures(),
    discardError: "Pull requests: write required",
  });
  const row = page.locator('#dependabot .n-row[data-pr-id="101"]');
  await row.hover();
  await row.locator(".dep-discard-action").click();
  await page.getByRole("menuitem", { name: /Confirm: discard and close/ }).click();

  await expect(page.locator("#toast")).toContainText("Pull requests: write required");
  await expect(row).toHaveCount(1);
});

test("groups active and recent operations by repository", async ({ page }) => {
  const operations = [
    mergeOperation({ id: 17, repo_full_name: "octo/hello" }),
    mergeOperation({
      id: 18,
      pr_id: 103,
      repo_full_name: "acme/widgets",
      number: 9,
      title: "Bump serde",
      html_url: "https://github.com/acme/widgets/pull/9",
      state: "queued",
      phase: "queued",
      strategy: "unknown",
      delegated_at: null,
      enqueued_at: "2026-06-27T10:01:00Z",
    }),
    mergeOperation({
      id: 19,
      state: "merged",
      phase: "merging",
      terminal_at: "2026-06-27T10:02:00Z",
    }),
  ];
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: operations });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  const active = page.locator('#dependabot .operation-section[data-operation-status="active"]');
  await expect(active.locator(".operation-repo-header .repo-name")).toHaveText([
    "octo/hello",
    "acme/widgets",
  ]);
  await expect(active.locator(".operation-repo-group")).toHaveCount(2);

  const recent = page.locator('#dependabot .operation-section[data-operation-status="recent"]');
  await expect(recent.locator(".operation-repo-group")).toHaveCount(1);
  await expect(recent.locator(".operation-repo-header .repo-name")).toHaveText("octo/hello");
});

test("cancels an active merge from Operations", async ({ page }) => {
  const operation = {
    id: 17,
    pr_id: 101,
    repo_full_name: "octo/hello",
    number: 40,
    title: "Bump lodash",
    html_url: "https://github.com/octo/hello/pull/40",
    base_ref: "main",
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

test("discards from an active operation after cancelling it safely", async ({ page }) => {
  const operation = mergeOperation({
    id: 17,
    state: "delegated",
    phase: "waiting_checks",
    queue_position: 1,
  });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();
  const row = page.locator('#dependabot .operation-row[data-operation-id="17"]');
  await expect(row.locator(".dep-operation-cancel")).toHaveCount(1);
  await expect(row.locator(".dep-discard-action")).toHaveCount(1);

  await row.locator(".dep-discard-action").click();
  await page.getByRole("menuitem", { name: /Confirm: discard and close/ }).click();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(() => window.__TAURI_CALLS__);
      return calls.filter((call) => call.cmd === "discard_dependabot_pr").length;
    })
    .toBeGreaterThanOrEqual(2);

  await page.locator('#dependabot-filter-list [data-filter="all"]').click();
  await expect(page.locator('#dependabot .n-row[data-pr-id="101"]')).toHaveCount(0);
  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((call) => call.cmd === "process_dependabot_merges")).toBe(true);
});

test("mock FIFO positions shift after the head is cancelled", async ({ page }) => {
  const head = mergeOperation({
    id: 17,
    state: "delegated",
    phase: "waiting_checks",
    queue_position: 1,
    enqueued_at: "2026-06-27T10:00:00Z",
  });
  const second = mergeOperation({
    id: 18,
    state: "queued",
    phase: "queued",
    queue_position: 2,
    enqueued_at: "2026-06-27T10:01:00Z",
  });
  const third = mergeOperation({
    id: 19,
    state: "queued",
    phase: "queued",
    queue_position: 3,
    enqueued_at: "2026-06-27T10:02:00Z",
  });
  await openDependabot(page, {
    ...defaultFixtures(),
    mergeOperations: [head, second, third],
  });

  const operations = await page.evaluate(async () => {
    await window.__TAURI__.core.invoke("cancel_dependabot_merge", { operationId: 17 });
    await window.__TAURI__.core.invoke("process_dependabot_merges");
    return window.__TAURI__.core.invoke("list_dependabot_merge_operations");
  });

  expect(operations.find((operation) => operation.id === 17).queue_position).toBeNull();
  expect(operations.find((operation) => operation.id === 18).queue_position).toBe(1);
  expect(operations.find((operation) => operation.id === 19).queue_position).toBe(2);
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

test("falls back to the operation row when its focused control disappears", async ({ page }) => {
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
  await page
    .locator('#dependabot .operation-row[data-operation-id="18"] .dep-operation-cancel')
    .focus();

  await page.evaluate(() =>
    window.__mockSetOperation(18, {
      state: "merged",
      terminal_at: "2026-06-27T10:02:00Z",
    }),
  );

  await expect(
    page.locator('#dependabot .operation-row[data-operation-id="18"] .n-open[tabindex]'),
  ).toBeFocused();
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

test("notification sidebar rerenders preserve Dependabot counts", async ({ page }) => {
  await openDependabot(page);

  const allCount = page.locator('#dependabot-filter-list [data-filter="all"] .source-count');
  const octoCount = page.locator('#dependabot-repo-list [data-repo="octo/hello"] .source-count');
  const acmeCount = page.locator('#dependabot-repo-list [data-repo="acme/widgets"] .source-count');
  await expect(allCount).toHaveText("3");
  await expect(octoCount).toHaveText("2");
  await expect(acmeCount).toHaveText("1");

  await page.locator('#filter-list [data-filter="all"]').evaluate((button) => button.click());

  await expect(allCount).toHaveText("3");
  await expect(octoCount).toHaveText("2");
  await expect(acmeCount).toHaveText("1");
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
  await expect(page.locator("#dependabot .op-step[aria-label*='completed']")).not.toHaveCount(0);
  await expect(page.locator("#dependabot .op-step[aria-label*='current']")).not.toHaveCount(0);
  await expect(page.locator("#dependabot .op-step[aria-label*='upcoming']")).not.toHaveCount(0);
  await expect(page.locator("#dependabot .op-log-message")).toContainText(
    "Merge operation queued.",
  );
  await expect(page.locator("#dependabot .op-log-heading")).toHaveJSProperty("tagName", "H4");

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
  const delegatedHead = mergeOperation({
    id: 55,
    state: "delegated",
    phase: "waiting_checks",
    enqueued_at: "2026-06-27T09:59:00Z",
  });
  const waitingHelix = mergeOperation({
    id: 52,
    state: "queued",
    phase: "queued",
    strategy: "unknown",
    enqueued_at: "2026-06-27T10:00:00Z",
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

/* ---------------------------------------------------------------------------------------
 * Phase 3: snapshot normalization and announcement behavior (issue #133).
 * - Sync progress is announced to the live region.
 * - Terminal operation transitions are announced when the Dependabot module is active.
 * - Returning to Dependabot announces a summary of any missed transitions.
 * - Unchanged poll snapshots produce no announcement noise.
 * --------------------------------------------------------------------------------------- */

test("sync announces start, completion, and result to the live region", async ({ page }) => {
  await openDependabot(page);

  // The auto-sync fires on first open; wait for the sync to complete and the live region
  // to receive the completion message.
  const announcer = page.locator("#a11y-announcer");
  await expect(announcer).toContainText(/Sync complete/);
});

test("a terminal operation transition announces to the live region while Dependabot is active", async ({
  page,
}) => {
  const operation = mergeOperation({ id: 50, state: "delegated", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  // Transition the operation to "merged" via the mock — fires dependabot:operations-changed.
  await page.evaluate(() =>
    window.__mockSetOperation(50, {
      state: "merged",
      phase: "merging",
      terminal_at: "2026-06-27T10:02:00Z",
    }),
  );

  const announcer = page.locator("#a11y-announcer");
  await expect(announcer).toContainText("#40 merged");
});

test("a failed operation transition announces with 'failed'", async ({ page }) => {
  const operation = mergeOperation({ id: 51, state: "delegated", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  await page.evaluate(() =>
    window.__mockSetOperation(51, {
      state: "failed",
      phase: "waiting_checks",
      failure_reason: "conflict",
      terminal_at: "2026-06-27T10:02:00Z",
    }),
  );

  const announcer = page.locator("#a11y-announcer");
  await expect(announcer).toContainText("#40 failed");
});

test("unchanged poll snapshots produce no announcement noise", async ({ page }) => {
  const operation = mergeOperation({
    id: 52,
    state: "merged",
    terminal_at: "2026-06-27T10:02:00Z",
  });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });
  await page.locator('#dependabot-filter-list [data-filter="operations"]').click();

  // Clear the announcer, then fire a no-op operations-changed.
  await page.evaluate(() => {
    document.getElementById("a11y-announcer").textContent = "";
  });
  await page.evaluate(() => window.__mockEmit("dependabot:operations-changed", null));

  // Give the queue time to drain, then verify no announcement was made.
  await page.waitForTimeout(400);
  const text = await page.locator("#a11y-announcer").textContent();
  // Should be empty or at most a re-announced view count — NOT a terminal transition.
  expect(text).not.toContain("merged");
  expect(text).not.toContain("failed");
});

test("every snapshot path clears a vanished repository refinement", async ({ page }) => {
  await openDependabot(page);

  // Refine to octo/hello.
  await page.locator('#dependabot-repo-list .repo-source[data-repo="octo/hello"]').click();
  await expect(page.locator("#dependabot .repo-name")).toHaveText("octo/hello");

  // Remove octo/hello from the mock groups, then fire a resolved event (triggers loadDependabot).
  await page.evaluate(() => {
    const remaining = [
      {
        full_name: "acme/widgets",
        total: 1,
        prs: [
          {
            id: 103,
            number: 9,
            title: "Bump serde",
            html_url: "https://github.com/acme/widgets/pull/9",
            author: "dependabot[bot]",
            base_ref: "main",
            updated_at: "2026-01-04T00:00:00Z",
            mergeable_state: "blocked",
          },
        ],
      },
    ];
    window.__mockSetDependabot(remaining);
    window.__mockEmit("dependabot:resolved", null);
  });

  // The refinement should be cleared — show acme/widgets.
  await expect(page.locator("#dependabot-view-title")).toContainText("Dependabot");
  await expect(page.locator("#dependabot-view-title")).not.toContainText("octo/hello");
});

test("returning to Dependabot announces a summary when operations have state", async ({ page }) => {
  const operation = mergeOperation({ id: 55, state: "delegated", phase: "waiting_checks" });
  await openDependabot(page, { ...defaultFixtures(), mergeOperations: [operation] });

  // Switch to notifications and back.
  await page.locator('.module-tab[data-module="notifications"]').click();

  // Transition the operation to "merged" while on notifications — this should be a missed
  // transition that queues for the on-return summary.
  await page.evaluate(() =>
    window.__mockSetOperation(55, {
      state: "merged",
      phase: "merging",
      terminal_at: "2026-06-27T10:02:00Z",
    }),
  );

  // Wait for the operations-changed event to propagate.
  await page.waitForTimeout(300);

  // Switch back to Dependabot.
  await page.locator('.module-tab[data-module="dependabot"]').click();
  await page.waitForSelector("#dependabot .repo-section, #dependabot .inbox-empty");

  const announcer = page.locator("#a11y-announcer");
  // Should mention "While away" or the operations summary.
  await expect(announcer).toContainText(/While away|Operations/);
});
