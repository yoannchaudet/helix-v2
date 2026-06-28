import { test, expect } from "@playwright/test";
import { openApp, defaultFixtures } from "./tauri-mock.js";

/* Settings pane: opening/closing, the poll-interval validation + save, and the theme picker
 * painting the document. */

test("opens Settings from the sidebar and closes via Back", async ({ page }) => {
  await openApp(page);

  await expect(page.locator("#view-settings")).toBeHidden();
  await page.locator("#open-settings").click();
  await expect(page.locator("#view-settings")).toBeVisible();

  await page.locator("#settings-back").click();
  await expect(page.locator("#view-settings")).toBeHidden();
});

test("opens Settings with the ⌘, / Ctrl, shortcut", async ({ page }) => {
  await openApp(page);

  // The handler accepts metaKey or ctrlKey; use Control for cross-platform CI.
  await page.keyboard.press("Control+Comma");
  await expect(page.locator("#view-settings")).toBeVisible();
});

test("rejects a poll interval below the minimum, then accepts a valid one", async ({
  page,
}) => {
  await openApp(page);
  await page.locator("#open-settings").click();

  const input = page.locator("#poll-interval");
  // Hydrated from get_settings (3600 in the fixture).
  await expect(input).toHaveValue("3600");

  // Below the 10s floor → inline error, no save.
  await input.fill("3");
  await input.blur();
  await expect(page.locator("#settings-flash")).toHaveText("Min 10s");
  await expect(page.locator("#settings-flash")).toHaveClass(/srow-flash--error/);

  // A valid value saves and flashes confirmation.
  await input.fill("60");
  await input.blur();
  await expect(page.locator("#settings-flash")).toHaveText("Saved");
});

test("the theme picker paints the document and persists the choice", async ({ page }) => {
  await openApp(page);
  await page.locator("#open-settings").click();

  // The radio inputs are visually hidden behind a segmented control; click the labels.
  await page.locator('.seg-opt:has(input[value="dark"])').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.locator('.seg-opt:has(input[value="light"])').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // The choice is mirrored to localStorage for the no-FOUC head script.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("helix-theme"))).toBe(
    "light",
  );
});

test("surfaces GitHub's poll-cadence override (refresh tooltip + Settings note)", async ({
  page,
}) => {
  // User wants 15s, but GitHub asks for 60s — so 60s is the effective interval.
  const fx = defaultFixtures();
  fx.settings.poll_interval_s = 15;
  fx.syncStatus.github_poll_interval_s = 60;
  await openApp(page, fx);

  // Refresh button tooltip explains the override.
  await expect(page.locator("#sync-btn")).toHaveAttribute(
    "title",
    /GitHub asks for ≥60s between polls, raising your 15s/,
  );

  // Settings note spells it out.
  await page.locator("#open-settings").click();
  await expect(page.locator("#poll-github-note")).toBeVisible();
  await expect(page.locator("#poll-github-note")).toContainText(
    "GitHub is currently asking for at least 60s",
  );
});

test("no override note when the user's interval already meets GitHub's floor", async ({
  page,
}) => {
  // Default fixture: user 3600s ≥ GitHub's 60s, so nothing is overridden.
  await openApp(page);

  await expect(page.locator("#sync-btn")).toHaveAttribute("title", "Sync now");
  await page.locator("#open-settings").click();
  await expect(page.locator("#poll-github-note")).toBeHidden();
});
