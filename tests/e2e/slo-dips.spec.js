import { test, expect } from "@playwright/test";
import { defaultFixtures, openApp } from "./tauri-mock.js";

async function openSloDips(page, fixtures = defaultFixtures()) {
  await openApp(page, fixtures);
  await page.locator('.module-tab[data-module="slo-dips"]').click();
}

async function inspectRepository(page, name = "octo/reliability") {
  await page.locator("#slo-dips-add-repo").click();
  const dialog = page.getByRole("dialog", { name: "Add SLO Dips repository" });
  await dialog.getByLabel("Repository").fill(name);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Choose Discussion categories" })).toBeVisible();
}

test("adds a canonical repository with multiple selected Discussion categories", async ({
  page,
}) => {
  await openSloDips(page);
  await inspectRepository(page);

  const dialog = page.getByRole("dialog", { name: "Choose Discussion categories" });
  await dialog.getByText("Select categories").click();
  await dialog.getByRole("checkbox", { name: /SLO Dips/ }).check();
  await dialog.getByRole("checkbox", { name: /Incidents/ }).check();
  await expect(dialog.getByText("2 categories selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Add repository" }).click();

  const source = page.locator('#slo-dips-repo-list [data-repo-id="9001"]');
  await expect(source).toContainText("Octo/Reliability");
  await expect(source).toContainText("2");
  await expect(source).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#slo-dips-view-title")).toContainText("Octo/Reliability");
  await expect(page.locator("#slo-dips-placeholder")).toContainText("📉 SLO Dips");
  await expect(page.locator("#slo-dips-placeholder")).toContainText("🚨 Incidents");

  await page.locator('.module-tab[data-module="notifications"]').click();
  await page.locator('.module-tab[data-module="slo-dips"]').click();
  await expect(source).toContainText("Octo/Reliability");
});

test("edits live category selections and removes the repository with confirmation", async ({
  page,
}) => {
  const fixtures = defaultFixtures();
  fixtures.sloDipsRepos = [
    {
      ...fixtures.sloDipsCatalog["octo/reliability"].repository,
      categories: fixtures.sloDipsCatalog["octo/reliability"].categories
        .slice(0, 2)
        .map(({ id, name, emoji }) => ({ id, name, emoji })),
    },
  ];
  await openSloDips(page, fixtures);

  const source = page.locator('#slo-dips-repo-list [data-repo-id="9001"]');
  await source.click();
  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit categories" }).click();

  const dialog = page.getByRole("dialog", { name: "Edit Discussion categories" });
  await dialog.getByText("2 categories selected").click();
  await expect(dialog.getByRole("checkbox", { name: /SLO Dips/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Incidents/ })).toBeChecked();
  await dialog.getByRole("checkbox", { name: /SLO Dips/ }).uncheck();
  await dialog.getByRole("checkbox", { name: /Announcements/ }).check();
  await dialog.getByRole("button", { name: "Save categories" }).click();

  await expect(page.locator("#slo-dips-placeholder")).not.toContainText("SLO Dips");
  await expect(page.locator("#slo-dips-placeholder")).toContainText("Incidents");
  await expect(page.locator("#slo-dips-placeholder")).toContainText("Announcements");
  await expect(source).toBeFocused();

  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove repository" }).click();
  await page.getByRole("menuitem", { name: "Confirm: remove Octo/Reliability" }).click();
  await expect(page.locator("#slo-dips-repo-list")).toContainText("No repositories yet.");
  await expect(page.locator("#slo-dips-add-repo")).toBeFocused();
});

test("keeps modal state on validation errors and closes with Escape", async ({ page }) => {
  const fixtures = defaultFixtures();
  fixtures.sloDipsCatalog["octo/empty"] = {
    repository: {
      id: 9002,
      full_name: "octo/empty",
      owner: "octo",
      name: "empty",
      private: false,
    },
    categories: [],
  };
  await openSloDips(page, fixtures);

  await page.locator("#slo-dips-add-repo").click();
  const dialog = page.getByRole("dialog", { name: "Add SLO Dips repository" });
  await dialog.getByLabel("Repository").fill("octo/empty");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByRole("alert")).toContainText("no GitHub Discussion categories");
  await expect(dialog.getByLabel("Repository")).toHaveValue("octo/empty");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#slo-dips-add-repo")).toBeFocused();
});
