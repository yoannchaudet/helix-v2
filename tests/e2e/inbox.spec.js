import { test, expect } from "@playwright/test";
import { openApp, emptyFixtures, defaultFixtures } from "./tauri-mock.js";

/* Inbox flows against mocked data: rendering, the smart filters + repo refinement, and the
 * three mark-done paths (per-row, bulk-confirm, context menu). */

test("a manual sync stays busy through resolution, then re-enables the controls", async ({
  page,
}) => {
  // Withhold the resolution `-done` event so we can observe the "busy through resolution" phase.
  await openApp(page, { ...defaultFixtures(), manualResolution: true });

  await page.locator("#sync-btn").click();
  // The list sync returns, but the sync button stays disabled and the pill stays "Syncing…"
  // while the subject-resolution pass runs.
  await expect(page.locator("#sync-btn")).toBeDisabled();
  await expect(page.locator(".js-sync-label").first()).toHaveText("Syncing…");

  // Completing the pass ends the sync: controls re-enable and the pill settles on success.
  // Regression guard: the status must not get stuck in the resolving phase.
  await page.evaluate(() => window.__mockEmit("subjects:resolution-done", { changed: 0 }));
  await expect(page.locator("#sync-btn")).toBeEnabled();
  await expect(page.locator(".js-sync-label").first()).toHaveClass(/status-label--success/);
});

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

test("an unresolved PR/Issue row shows the awaiting-state stripe cue", async ({ page }) => {
  const fx = defaultFixtures();
  // Simulate a row pulled but not yet resolved (no subject_state); its neighbor stays resolved.
  fx.inbox[0].notifications[0].subject_state = null;
  await openApp(page, fx);

  await expect(page.locator('.n-row[data-thread-id="t1"]')).toHaveClass(/n-row--awaiting/);
  await expect(page.locator('.n-row[data-thread-id="t2"]')).not.toHaveClass(/n-row--awaiting/);
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
  // A mouse click switches filter without moving focus, so no ring is painted.
  await expect(page.locator("#inbox .n-row:first-child .n-open")).not.toBeFocused();
});

test("refining by repository shows only that repo, with a breadcrumb", async ({ page }) => {
  await openApp(page);

  await page.locator('.repo-source[data-repo="2"]').click();

  await expect(page.locator("#inbox .repo-section")).toHaveCount(1);
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator("#view-title .crumb-repo")).toHaveText("acme/widgets");
});

test("the subject-type pills narrow the whole view and reduce counts", async ({ page }) => {
  await openApp(page);

  // All three pills are on by default → the full fixture shows (2 PRs + 1 Issue).
  await expect(page.locator(".type-pill")).toHaveCount(3);
  await expect(page.locator('.type-pill[data-type="pr"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#inbox .n-row")).toHaveCount(3);

  // Turn PRs off → only the Issue (t2, octo/hello) remains; acme/widgets (PR-only) drops out.
  await page.locator('.type-pill[data-type="pr"]').click();
  await expect(page.locator('.type-pill[data-type="pr"]')).toHaveAttribute("aria-pressed", "false");
  // Toggling updates the pill in place, so the activated pill keeps focus (no DOM teardown).
  await expect(page.locator('.type-pill[data-type="pr"]')).toBeFocused();
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator(".n-title")).toContainText("Crash on launch");
  await expect(page.locator("#inbox .repo-section")).toHaveCount(1);
  // Smart-filter + repo counts shrink to match the type selection.
  await expect(page.locator('.source-count[data-count="all"]')).toHaveText("1");
  await expect(page.locator('.source-count[data-count="cleanup"]')).toHaveText("");
  await expect(page.locator('.repo-source[data-repo="2"]')).toHaveCount(0);

  // Clicking the last remaining pill is a no-op — at least one type stays selected.
  // Turn Other off too, leaving only Issues selected…
  await page.locator('.type-pill[data-type="other"]').click();
  await expect(page.locator('.type-pill[data-type="issue"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // …then clicking Issues (now the only one) must not deselect it.
  await page.locator('.type-pill[data-type="issue"]').click();
  await expect(page.locator('.type-pill[data-type="issue"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
});

test("row hover is class-driven and clears when the pointer leaves", async ({ page }) => {
  await openApp(page);

  const row = page.locator('.n-row[data-thread-id="t2"]');
  // Hovering marks the row (revealing its controls) via a JS class, not CSS `:hover` — this is
  // what lets a background re-render drop the marker so controls can't get stuck visible in the
  // macOS WKWebView.
  await row.hover();
  await expect(row).toHaveClass(/n-row--hover/);

  // Moving the pointer off the row (onto the repo header) clears the marker (controls hide).
  await page.locator("#inbox .repo-header").first().hover();
  await expect(row).not.toHaveClass(/n-row--hover/);

  // Leaving the list entirely also clears it (the mouseleave path — WKWebView can otherwise
  // leave the class stuck on the live node).
  await row.hover();
  await expect(row).toHaveClass(/n-row--hover/);
  await page.mouse.move(5, 5);
  await expect(row).not.toHaveClass(/n-row--hover/);
});

test("a mouseover sweeps stray hover markers off other rows (WKWebView re-render defense)", async ({
  page,
}) => {
  await openApp(page);

  // Simulate the WKWebView failure mode: a re-render storm leaves the hover marker stuck on
  // several live rows (mouseout/mouseover dropped or mis-targeted during innerHTML swaps).
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("#inbox .n-row")) el.classList.add("n-row--hover");
  });
  await expect(page.locator("#inbox .n-row--hover")).toHaveCount(3);

  // Any pointer movement over the list must collapse it back to exactly the row under the
  // cursor — so the stuck controls hide as soon as the user moves the mouse.
  await page.locator('.n-row[data-thread-id="t1"]').hover();
  await expect(page.locator("#inbox .n-row--hover")).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t1"]')).toHaveClass(/n-row--hover/);

  // A stray appearing on ANOTHER row while t1 is already hovered must also be swept by the next
  // mouseover within t1 (regression guard: no early-return may skip the sweep).
  await page.evaluate(() => {
    document.querySelector('.n-row[data-thread-id="t2"]').classList.add("n-row--hover");
  });
  await page.locator('.n-row[data-thread-id="t1"] .n-title').hover();
  await expect(page.locator("#inbox .n-row--hover")).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t1"]')).toHaveClass(/n-row--hover/);
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
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-done-spacer')).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t2"] button.n-done')).toHaveCount(0);
});

test("focus restoration never lands on a mark-as-done control (unresolved survivors)", async ({
  page,
}) => {
  const fx = defaultFixtures();
  // One repo: an openable (resolved) row plus an unresolved row with no URL (not openable, no
  // `.n-open[tabindex]`). Marking the openable one done leaves the unresolved row as the focus
  // survivor — focus must NOT fall onto its `.n-done` (that reveals the stray check).
  fx.inbox = [
    {
      repo_id: 1,
      full_name: "octo/hello",
      private: false,
      notifications: [
        {
          thread_id: "open1",
          subject_type: "PullRequest",
          subject_title: "Openable",
          subject_number: 1,
          subject_state: "open",
          subject_html_url: "https://github.com/octo/hello/pull/1",
          reason: "mention",
          updated_at: "2026-06-27T10:00:00Z",
        },
        {
          thread_id: "await1",
          subject_type: "Issue",
          subject_title: "Unresolved",
          reason: "mention",
          updated_at: "2026-06-27T09:00:00Z",
        },
      ],
    },
  ];
  await openApp(page, fx);

  await page.locator('.n-row[data-thread-id="open1"]').hover();
  await page.locator('.n-row[data-thread-id="open1"] .n-done').click();

  // The openable row is gone; the survivor is unresolved. Focus should park on the inbox
  // container, never a mark-as-done button.
  await expect(page.locator('.n-row[data-thread-id="open1"]')).toHaveCount(0);
  const activeIsDone = await page.evaluate(
    () => document.activeElement?.classList.contains("n-done") ?? false,
  );
  expect(activeIsDone).toBe(false);
});

test("marking done in the Bookmarks filter keeps focus on the same row", async ({ page }) => {
  await openApp(page);

  // Bookmark a row and view the Bookmarks filter.
  await page.locator('.n-row[data-thread-id="t2"]').hover();
  await page.locator('.n-row[data-thread-id="t2"] .n-bookmark').click();
  await page.keyboard.press("7"); // Bookmarks filter (keyboard → focuses first row)
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).toBeFocused();

  // Mark it done with `d`: the row stays (now done) and focus doesn't hop away.
  await page.keyboard.press("d");
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).toBeFocused();
  // And the now-done row no longer offers a mark-as-done button.
  await expect(page.locator('.n-row[data-thread-id="t2"] button.n-done')).toHaveCount(0);

  // Pressing `d` again on the done row is a no-op (it stays, still done).
  await page.keyboard.press("d");
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  await expect(page.locator('.n-row[data-thread-id="t2"]')).toHaveAttribute("data-done", "true");
});
