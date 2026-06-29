import { test, expect } from "@playwright/test";
import { openApp, emptyFixtures, defaultFixtures } from "./tauri-mock.js";

/* Inbox flows against mocked data: rendering, the smart filters + repo refinement, and the
 * three mark-done paths (per-row, bulk-confirm, context menu). */

test("renders the inbox grouped by repo with sidebar counts", async ({ page }) => {
  await openApp(page);

  await expect(page.locator("#inbox .repo-section")).toHaveCount(2);
  await expect(page.locator("#inbox .n-row")).toHaveCount(3);
  await expect(page.locator("#view-title")).toHaveText("All");

  // Smart-filter counts reflect the fixture (all=3, mention=1, review=1, assign=1, cleanup=1).
  await expect(page.locator('.source-count[data-count="all"]')).toHaveText("3");
  await expect(page.locator('.source-count[data-count="mention"]')).toHaveText("1");
  await expect(page.locator('.source-count[data-count="review_requested"]')).toHaveText("1");
  await expect(page.locator('.source-count[data-count="cleanup"]')).toHaveText("1");
  // A reason with no matches renders no count badge.
  await expect(page.locator('.source-count[data-count="team_mention"]')).toHaveText("");

  // Most-recent-first ordering: acme/widgets (11:00) sorts above octo/hello (10:00).
  await expect(page.locator(".repo-name").first()).toHaveText("acme/widgets");
});

test("selecting a smart filter narrows the list and updates the title", async ({ page }) => {
  await openApp(page);

  await page.locator('.source[data-filter="mention"]').click();

  await expect(page.locator("#view-title")).toHaveText("Mentions");
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator(".n-title")).toContainText("Crash on launch");
  await expect(page.locator('.source[data-filter="mention"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  // Choosing a filter focuses its first row, so single-key commands act on a real selection.
  await expect(page.locator("#inbox .n-row:first-child .n-open")).toBeFocused();
});

test("refining by repository shows only that repo, with a breadcrumb", async ({ page }) => {
  await openApp(page);

  await page.locator('.repo-source[data-repo="2"]').click();

  await expect(page.locator("#inbox .repo-section")).toHaveCount(1);
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator("#view-title .crumb-repo")).toHaveText("acme/widgets");
});

test("marking a single row done removes it and decrements the count", async ({ page }) => {
  await openApp(page);

  // The per-row done button is revealed (and made clickable) on row hover.
  await page.locator('.n-row[data-thread-id="t2"]').hover();
  await page.locator('.n-row[data-thread-id="t2"] .n-done').click();

  await expect(page.locator('.n-row[data-thread-id="t2"]')).toHaveCount(0);
  await expect(page.locator("#inbox .n-row")).toHaveCount(2);
  await expect(page.locator('.source-count[data-count="all"]')).toHaveText("2");
});

test("bulk mark-all confirms, then clears the whole view", async ({ page }) => {
  await openApp(page);

  await page.locator("#mark-all-done-btn").click();
  // The destructive action is gated behind an in-app confirm popover.
  const confirm = page.getByRole("menuitem", { name: /Confirm: mark 3 as done/ });
  await expect(confirm).toBeVisible();
  await confirm.click();

  await expect(page.locator("#inbox .n-row")).toHaveCount(0);
  await expect(page.locator(".inbox-empty")).toContainText("You're all caught up.");
});

test("the bulk confirm popover can be dismissed without marking anything", async ({ page }) => {
  await openApp(page);

  await page.locator("#mark-all-done-btn").click();
  await page.getByRole("menuitem", { name: "Cancel" }).click();

  await expect(page.locator(".context-menu")).toHaveCount(0);
  await expect(page.locator("#inbox .n-row")).toHaveCount(3);
});

test("right-click offers Copy URL + Mark as done; Mark as done removes the row", async ({
  page,
}) => {
  await openApp(page);

  await page.locator('.n-row[data-thread-id="t1"] .n-open').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy URL" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as done" }).click();

  await expect(page.locator('.n-row[data-thread-id="t1"]')).toHaveCount(0);
});

test("right-click can open the row's repository in the browser", async ({ page }) => {
  await openApp(page);

  // t1 lives in octo/hello.
  await page.locator('.n-row[data-thread-id="t1"] .n-open').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open repository" }).click();

  const opened = await page.evaluate(() =>
    window.__TAURI_CALLS__.filter((c) => c.cmd === "open_url").map((c) => c.args.url),
  );
  expect(opened).toContain("https://github.com/octo/hello");
});

test("Open repository works for a subject with no link of its own (agent session)", async ({
  page,
}) => {
  // A Copilot agent-session notification: no subject_html_url, so "Copy URL" is unavailable,
  // but the repository link still is.
  const fx = defaultFixtures();
  fx.inbox = [
    {
      repo_id: 9,
      full_name: "octo/agent",
      private: false,
      notifications: [
        {
          thread_id: "a1",
          subject_type: "AgentSessionThread",
          subject_title: "Configuring dependabot",
          subject_number: null,
          subject_state: null,
          subject_html_url: null,
          reason: "agent_session_finished",
          updated_at: "2026-06-27T22:29:48Z",
        },
      ],
    },
  ];
  await openApp(page, fx);

  await page.locator('.n-row[data-thread-id="a1"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy URL" })).toBeDisabled();
  const openRepo = page.getByRole("menuitem", { name: "Open repository" });
  await expect(openRepo).toBeEnabled();
  await openRepo.click();

  const opened = await page.evaluate(() =>
    window.__TAURI_CALLS__.filter((c) => c.cmd === "open_url").map((c) => c.args.url),
  );
  expect(opened).toContain("https://github.com/octo/agent");
});

test("an empty inbox shows the all-caught-up state", async ({ page }) => {
  await openApp(page, emptyFixtures());

  await expect(page.locator(".inbox-empty")).toContainText("You're all caught up.");
  await expect(page.locator("#inbox .n-row")).toHaveCount(0);
});

test("bookmarking a row marks it, fills the Bookmarks filter, and is removable", async ({
  page,
}) => {
  await openApp(page);

  await expect(page.locator('.source-count[data-count="bookmarked"]')).toHaveText("");

  await page.locator('.n-row[data-thread-id="t2"]').hover();
  await page.locator('.n-row[data-thread-id="t2"] .n-bookmark').click();

  // The row gains the bookmarked state, the sidebar count goes to 1.
  await expect(page.locator('.n-row[data-thread-id="t2"]')).toHaveClass(/n-row--bookmarked/);
  await expect(page.locator('.source-count[data-count="bookmarked"]')).toHaveText("1");

  // The Bookmarks filter shows just that row.
  await page.locator('.source[data-filter="bookmarked"]').click();
  await expect(page.locator("#view-title")).toHaveText("Bookmarks");
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);

  // Un-bookmark empties the filter.
  await page.locator('.n-row[data-thread-id="t2"] .n-bookmark').click();
  await expect(page.locator("#inbox .n-row")).toHaveCount(0);
  await expect(page.locator('.source-count[data-count="bookmarked"]')).toHaveText("");
});

test("a bookmark survives marking the thread done", async ({ page }) => {
  await openApp(page);

  await page.locator('.n-row[data-thread-id="t2"]').hover();
  await page.locator('.n-row[data-thread-id="t2"] .n-bookmark').click();
  await page.locator('.n-row[data-thread-id="t2"]').hover();
  await page.locator('.n-row[data-thread-id="t2"] .n-done').click();

  // Gone from the inbox, but the bookmark snapshot keeps it in the Bookmarks filter.
  await expect(page.locator('.n-row[data-thread-id="t2"]')).toHaveCount(0);
  await page.locator('.source[data-filter="bookmarked"]').click();
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator('.source-count[data-count="bookmarked"]')).toHaveText("1");
  // A done bookmark has no mark-as-done button, just an inert spacer keeping alignment.
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-done--spacer')).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t2"] button.n-done')).toHaveCount(0);
});
