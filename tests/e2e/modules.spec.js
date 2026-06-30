import { test, expect } from "@playwright/test";
import { openApp } from "./tauri-mock.js";

/* The module system: the Lightroom-style title-bar picker, ⌘1/⌘2 jumps, and the
 * Settings-overlay interplay. */

test("the picker shows both modules; Notifications is active by default", async ({ page }) => {
  await openApp(page);

  await expect(page.locator(".module-tab")).toHaveCount(2);
  await expect(page.locator('.module-tab[data-module="notifications"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("#view-notifications")).toBeVisible();
  await expect(page.locator("#view-dependabot")).toBeHidden();
});

test("clicking a module swaps the visible pane and active tab", async ({ page }) => {
  await openApp(page);

  await page.locator('.module-tab[data-module="dependabot"]').click();

  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();
  await expect(page.locator("#view-dependabot")).toContainText("coming soon");
  await expect(page.locator('.module-tab[data-module="dependabot"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator('.module-tab[data-module="notifications"]')).not.toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("⌘1 / ⌘2 jump straight to a module", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("Meta+2");
  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();

  await page.keyboard.press("Meta+1");
  await expect(page.locator("#view-notifications")).toBeVisible();
  await expect(page.locator("#view-dependabot")).toBeHidden();
});

test("the Notifications module shows the sidebar; Dependabot hides it", async ({ page }) => {
  await openApp(page);

  await expect(page.locator(".sidebar")).toBeVisible();

  await page.locator('.module-tab[data-module="dependabot"]').click();
  await expect(page.locator(".sidebar")).toBeHidden();

  await page.locator('.module-tab[data-module="notifications"]').click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("the picker stays in the chrome during Settings; switching modules leaves Settings", async ({ page }) => {
  await openApp(page);

  await page.locator("#open-settings").click();
  await expect(page.locator("#view-settings")).toBeVisible();
  // The picker is app-level chrome, so it persists over the Settings overlay.
  await expect(page.locator(".module-picker")).toBeVisible();
  // The sidebar is hidden under the full-width Settings overlay.
  await expect(page.locator(".sidebar")).toBeHidden();

  // ⌘2 from Settings dismisses the overlay and lands on the Dependabot module.
  await page.keyboard.press("Meta+2");
  await expect(page.locator("#view-settings")).toBeHidden();
  await expect(page.locator("#view-dependabot")).toBeVisible();
});

test("closing Settings returns to the active (non-default) module", async ({ page }) => {
  await openApp(page);

  // Switch to Dependabot, open Settings, then close it — we should land back on Dependabot.
  await page.locator('.module-tab[data-module="dependabot"]').click();
  await page.locator("#open-settings").click();
  await expect(page.locator("#view-settings")).toBeVisible();

  await page.locator("#settings-back").click();
  await expect(page.locator("#view-settings")).toBeHidden();
  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();
});
