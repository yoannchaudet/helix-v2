import { test, expect } from "@playwright/test";
import { openApp } from "./tauri-mock.js";

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
