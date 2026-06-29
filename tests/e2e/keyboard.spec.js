import { test, expect } from "@playwright/test";
import { openApp } from "./tauri-mock.js";

/* The power-user keyboard command model. (The macOS menu → cheatsheet path needs a native
 * menu and is verified manually; here we cover the `?` overlay and the inbox commands.) */

// Grant clipboard so the `c` copy path resolves via navigator.clipboard.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("j / k move the keyboard cursor through the rows", async ({ page }) => {
  await openApp(page);

  // Rows render most-recent-first: acme/widgets (t3), then octo/hello (t1, t2).
  await page.keyboard.press("j");
  await expect(page.locator('.n-row[data-thread-id="t3"] .n-open')).toBeFocused();

  await page.keyboard.press("j");
  await expect(page.locator('.n-row[data-thread-id="t1"] .n-open')).toBeFocused();

  await page.keyboard.press("k");
  await expect(page.locator('.n-row[data-thread-id="t3"] .n-open')).toBeFocused();
});

test("d marks the active row done", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("j"); // focus t3
  await page.keyboard.press("d");

  await expect(page.locator('.n-row[data-thread-id="t3"]')).toHaveCount(0);
  await expect(page.locator("#inbox .n-row")).toHaveCount(2);
});

test("b bookmarks the active row", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("j"); // focus t3
  await page.keyboard.press("b");

  await expect(page.locator('.n-row[data-thread-id="t3"]')).toHaveClass(/n-row--bookmarked/);
  await expect(page.locator('.source-count[data-count="bookmarked"]')).toHaveText("1");
});

test("c copies the active row's URL", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("j");
  await page.keyboard.press("c");

  await expect(page.locator(".toast")).toContainText("Copied URL");
});

test("r triggers a sync", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("r");

  await expect
    .poll(() => page.evaluate(() => window.__TAURI_CALLS__.some((c) => c.cmd === "sync_now")))
    .toBe(true);
});

test("number keys switch the smart filter", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("2"); // 1=all, 2=mention
  await expect(page.locator("#view-title")).toHaveText("Mentions");
  await expect(page.locator("#inbox .n-row")).toHaveCount(1);
  // Keyboard-driven switch shows the selection ring on the first row.
  await expect(page.locator("#inbox .n-row:first-child .n-open")).toHaveClass(/kbd-focus/);

  await page.keyboard.press("1");
  await expect(page.locator("#view-title")).toHaveText("All");
});

test("? opens the shortcuts cheatsheet; Esc closes it", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("?");
  const overlay = page.locator(".shortcuts-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("Keyboard shortcuts");
  await expect(overlay.getByText("Mark as done")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
});

test("command keys are inert while the cheatsheet is open", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("?");
  await expect(page.locator(".shortcuts-overlay")).toBeVisible();
  // `2` would switch filters if it leaked through; it must not.
  await page.keyboard.press("2");
  await expect(page.locator("#view-title")).toHaveText("All");
});

test("typing in a settings field does not trigger commands", async ({ page }) => {
  await openApp(page);
  await page.locator("#open-settings").click();

  // The notifications pane is hidden, so inbox commands are inert; typing is unaffected.
  await page.locator("#poll-interval").fill("");
  await page.locator("#poll-interval").type("45");
  await expect(page.locator("#poll-interval")).toHaveValue("45");
});
