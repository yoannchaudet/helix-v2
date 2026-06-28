import { test, expect } from "@playwright/test";
import { openApp, signedOutFixtures } from "./tauri-mock.js";

/* Account / signed-out flows. */

test("signed out: the inbox prompts to connect an account", async ({ page }) => {
  await openApp(page, signedOutFixtures());

  await expect(page.locator(".inbox-empty")).toContainText(
    "Connect your GitHub account",
  );
  await expect(page.locator(".inbox-empty .js-goto-settings")).toBeVisible();
});

test("signed out: the empty-state button opens Settings", async ({ page }) => {
  await openApp(page, signedOutFixtures());

  await page.locator(".inbox-empty .js-goto-settings").click();
  await expect(page.locator("#view-settings")).toBeVisible();
  // The Account group offers the sign-in form.
  await expect(page.locator("#signin-form")).toBeVisible();
});

test("signing in with a token renders the signed-in identity", async ({ page }) => {
  await openApp(page, signedOutFixtures());
  await page.locator(".inbox-empty .js-goto-settings").click();

  await page.locator("#pat").fill("ghp_exampletoken");
  await page.locator("#signin-btn").click();

  await expect(page.locator("#account-body")).toContainText("The Octocat");
  await expect(page.locator("#account-body")).toContainText("@octocat");
});
