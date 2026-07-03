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

test("shows a merge-readiness pill and no bookmark/done controls", async ({ page }) => {
  await openDependabot(page);

  // clean → "Ready", blocked → "Blocked" (from the fixture's mergeable_state values).
  await expect(page.locator("#dependabot .merge--clean")).toHaveCount(1);
  await expect(page.locator("#dependabot .merge--blocked")).toHaveCount(1);

  // Read-only: none of the notification action affordances exist here.
  await expect(page.locator("#dependabot .n-bookmark")).toHaveCount(0);
  await expect(page.locator("#dependabot .n-done")).toHaveCount(0);
  await expect(page.locator("#view-dependabot #mark-all-done-btn")).toHaveCount(0);
});

test("the sidebar lists repositories and refines the list", async ({ page }) => {
  await openDependabot(page);

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

  // Click again to clear the refinement → both repos back.
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

test("the accounts picker lists user + orgs and persists a change on close", async ({ page }) => {
  await openDependabot(page);

  await page.locator("#dependabot-accounts-btn").click();
  const popover = page.locator(".accounts-popover");
  await expect(popover).toBeVisible();

  // Your user (pre-selected) + the two orgs from the fixture.
  await expect(popover.locator(".accounts-check")).toHaveCount(3);
  await expect(popover.locator('.accounts-check[data-login="octocat"]')).toBeChecked();
  await expect(popover.locator('.accounts-check[data-login="acme"]')).not.toBeChecked();

  // Select an org, then close the popover by clicking outside.
  await popover.locator('.accounts-check[data-login="acme"]').check();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The new selection is persisted and a re-sync is triggered.
  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  const saved = calls.filter((c) => c.cmd === "set_dependabot_owners").pop();
  expect(saved, "set_dependabot_owners should have been invoked").toBeTruthy();
  expect(saved.args.owners).toEqual(["octocat", "acme"]);
});

test("closing the picker with no change does not persist or re-sync", async ({ page }) => {
  await openDependabot(page);
  await page.evaluate(() => (window.__TAURI_CALLS__.length = 0));

  await page.locator("#dependabot-accounts-btn").click();
  await expect(page.locator(".accounts-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".accounts-popover")).toBeHidden();

  const calls = await page.evaluate(() => window.__TAURI_CALLS__);
  expect(calls.some((c) => c.cmd === "set_dependabot_owners")).toBe(false);
});
