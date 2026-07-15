import { test, expect } from "@playwright/test";
import { openApp, defaultFixtures, installTauriMock } from "./tauri-mock.js";

/* The module system: the segmented title-bar picker, ⌘1/⌘2 jumps, and the
 * Settings-overlay interplay. */

test("the left-side module bar shows both modules and the active indicator", async ({ page }) => {
  await openApp(page);

  const chromeOrder = await page.locator(".topchrome").evaluate((chrome) =>
    [...chrome.children].map((child) => {
      if (child.classList.contains("module-picker")) return "picker";
      if (child.classList.contains("topchrome-brand")) return "brand";
      return "actions";
    }),
  );
  expect(chromeOrder).toEqual(["picker", "brand", "actions"]);

  await expect(page.locator(".module-tab")).toHaveCount(2);
  await expect(page.locator('.module-tab[data-module="dependabot"]')).toHaveText("Automation PRs");
  await expect(page.locator(".module-picker-indicator")).toHaveCount(1);
  await expect(page.locator(".module-picker-indicator")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator(".module-picker-indicator")).toHaveCSS("pointer-events", "none");
  await expect(page.locator(".module-picker-indicator")).toHaveCSS(
    "transition-property",
    "transform",
  );
  await expect(page.locator(".topchrome-brand")).toHaveCSS("justify-content", "center");
  await expect(page.locator(".module-picker")).toHaveAttribute("data-active-index", "0");
  const geometry = await page.evaluate(() => {
    const picker = document.querySelector(".module-picker").getBoundingClientRect();
    const brand = document.querySelector(".topchrome-brand").getBoundingClientRect();
    const indicator = document.querySelector(".module-picker-indicator").getBoundingClientRect();
    const tab = document.querySelector(".module-tab").getBoundingClientRect();
    return {
      pickerRight: picker.right,
      brandLeft: brand.left,
      indicatorWidth: indicator.width,
      tabWidth: tab.width,
    };
  });
  expect(geometry.pickerRight).toBeLessThanOrEqual(geometry.brandLeft);
  expect(Math.abs(geometry.indicatorWidth - geometry.tabWidth)).toBeLessThan(1);
  await expect(page.locator('.module-tab[data-module="notifications"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.locator("#view-notifications")).toBeVisible();
  await expect(page.locator("#view-dependabot")).toBeHidden();
});

test("clicking a module swaps the visible pane and active tab", async ({ page }) => {
  await openApp(page);

  const indicator = page.locator(".module-picker-indicator");
  const initialOffset = await indicator.evaluate(
    (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
  );
  await page.locator('.module-tab[data-module="dependabot"]').click();

  await expect(page.locator(".module-picker")).toHaveAttribute("data-active-index", "1");
  await expect
    .poll(() =>
      indicator.evaluate(
        (element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
      ),
    )
    .toBeGreaterThan(initialOffset);
  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();
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

  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).toBeFocused();

  await page.keyboard.press("Meta+2");
  await expect(page.locator(".module-picker")).toHaveAttribute("data-active-index", "1");
  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();
  await expect(page.locator('#dependabot .n-row[data-pr-id="103"] .n-open')).toBeFocused();
  await expect(page.locator('#dependabot .n-row[data-pr-id="103"] .n-open')).toHaveClass(
    /kbd-focus/,
  );

  await page.keyboard.press("Meta+1");
  await expect(page.locator(".module-picker")).toHaveAttribute("data-active-index", "0");
  await expect(page.locator("#view-notifications")).toBeVisible();
  await expect(page.locator("#view-dependabot")).toBeHidden();
  await expect(page.locator('.n-row[data-thread-id="t3"] .n-open')).toBeFocused();
  await expect(page.locator('.n-row[data-thread-id="t3"] .n-open')).toHaveClass(/kbd-focus/);
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).not.toHaveClass(/kbd-focus/);
});

test("clicking module tabs does not force a first-row keyboard focus ring", async ({ page }) => {
  await openApp(page);

  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).toBeFocused();

  await page.locator('.module-tab[data-module="dependabot"]').click();
  await expect(page.locator('#dependabot .n-row[data-pr-id="103"] .n-open')).toBeFocused();
  await expect(page.locator("#dependabot .n-open.kbd-focus")).toHaveCount(0);

  await page.locator('.module-tab[data-module="notifications"]').click();
  await expect(page.locator('.n-row[data-thread-id="t3"] .n-open')).toBeFocused();
  await expect(page.locator('.n-row[data-thread-id="t2"] .n-open')).not.toBeFocused();
  await expect(page.locator("#inbox .n-open.kbd-focus")).toHaveCount(0);
});

test("each module shows its own sidebar sources; Settings hides the sidebar", async ({ page }) => {
  await openApp(page);

  // Notifications: sidebar visible with its smart-filter list.
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar-module--notifications")).toBeVisible();
  await expect(page.locator(".sidebar-module--dependabot")).toBeHidden();

  // Dependabot: sidebar still visible, but showing only its repo list.
  await page.locator('.module-tab[data-module="dependabot"]').click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".sidebar-module--dependabot")).toBeVisible();
  await expect(page.locator(".sidebar-module--notifications")).toBeHidden();
  await expect(page.locator("#filter-list")).toBeHidden();

  await page.locator('.module-tab[data-module="notifications"]').click();
  await expect(page.locator(".sidebar-module--notifications")).toBeVisible();
});

test("the picker stays in the chrome during Settings; switching modules leaves Settings", async ({
  page,
}) => {
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

test("the module bar fits the minimum window width and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixtures = defaultFixtures();
  fixtures.settings.theme = "dark";
  await openApp(page, fixtures);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const geometry = await page.evaluate(() => {
    const picker = document.querySelector(".module-picker").getBoundingClientRect();
    const brand = document.querySelector(".topchrome-brand").getBoundingClientRect();
    const actions = document.querySelector(".topchrome-actions").getBoundingClientRect();
    const transitionDuration = Number.parseFloat(
      getComputedStyle(document.querySelector(".module-picker-indicator")).transitionDuration,
    );
    return {
      pickerLeft: picker.left,
      pickerRight: picker.right,
      brandLeft: brand.left,
      brandRight: brand.right,
      actionsLeft: actions.left,
      transitionDuration,
    };
  });

  expect(geometry.pickerLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.pickerRight).toBeLessThanOrEqual(geometry.brandLeft);
  expect(geometry.brandRight).toBeLessThanOrEqual(geometry.actionsLeft);
  expect(geometry.transitionDuration).toBeLessThan(0.001);
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

test("the last opened module is restored on launch", async ({ page }) => {
  // Seed persisted state as if Dependabot was open when the app last closed. We can't use
  // openApp's helper here because it waits on the (now hidden) notifications inbox pane.
  await page.addInitScript(installTauriMock, { ...defaultFixtures(), lastModule: "dependabot" });
  await page.goto("/");

  await expect(page.locator("#view-dependabot")).toBeVisible();
  await expect(page.locator("#view-notifications")).toBeHidden();
  await expect(page.locator(".module-picker")).toHaveAttribute("data-active-index", "1");
  await expect(page.locator('.module-tab[data-module="dependabot"]')).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("right-clicking the brand flips it to reveal the app version", async ({ page }) => {
  await openApp(page);

  const brand = page.locator("#brand-flip");
  const back = page.locator("#brand-version");

  // The default fixture reports app version 0.1.0; the back face is prepared but hidden.
  await expect(back).toHaveText("v0.1.0");
  await expect(brand).not.toHaveClass(/is-flipped/);
  await expect(back).toHaveAttribute("aria-hidden", "true");

  // Right-click flips the card (and suppresses the native context menu); the version face
  // becomes the exposed one. No need to wait out the 5s auto-revert — assert the immediate state.
  await brand.click({ button: "right" });
  await expect(brand).toHaveClass(/is-flipped/);
  await expect(brand).toHaveAttribute("aria-pressed", "true");
  await expect(back).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator(".brand-face-front")).toHaveAttribute("aria-hidden", "true");

  // Right-clicking again flips it straight back.
  await brand.click({ button: "right" });
  await expect(brand).not.toHaveClass(/is-flipped/);
  await expect(brand).toHaveAttribute("aria-pressed", "false");
  await expect(back).toHaveAttribute("aria-hidden", "true");
});
