import { test, expect } from "@playwright/test";
import { defaultFixtures, openApp } from "./tauri-mock.js";

async function openSloDips(page, fixtures = defaultFixtures()) {
  await openApp(page, fixtures);
  await page.locator('.module-tab[data-module="slo-dips"]').click();
}

async function inspectRepository(page, name = "octo/reliability") {
  await page.locator("#slo-dips-add-repo").click();
  const content = page.locator("#slo-dips-content");
  await content.getByLabel("Repository").fill(name);
  await content.getByRole("button", { name: "Continue" }).click();
  await expect(content.getByRole("group", { name: "Discussion categories" })).toBeVisible();
}

test("adds a canonical repository with multiple selected Discussion categories", async ({
  page,
}) => {
  await openSloDips(page);
  await inspectRepository(page);

  const content = page.locator("#slo-dips-content");
  await expect(content.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(content).not.toContainText('<button type="button"');
  await content.getByRole("checkbox", { name: /SLO Dips/ }).check();
  await expect(content.getByText("Service-level objective regressions")).toBeVisible();
  await expect(
    content
      .getByRole("checkbox", { name: /SLO Dips/ })
      .locator("xpath=..")
      .locator("img"),
  ).toHaveAttribute("src", /github\.githubassets\.com/);
  await content.getByRole("checkbox", { name: /Incidents/ }).check();
  await expect(content.getByText("2 categories selected")).toBeVisible();
  await content.getByRole("button", { name: "Add repository" }).click();

  const source = page.locator('#slo-dips-repo-list [data-repo-id="9001"]');
  await expect(source).toContainText("Octo/Reliability");
  await expect(source).toContainText("2");
  await expect(source).toHaveAttribute("aria-current", "true");
  await expect(page.locator("#slo-dips-view-title")).toContainText("Octo/Reliability");
  await expect(content.getByRole("checkbox", { name: /SLO Dips/ })).toBeChecked();
  await expect(content.getByRole("checkbox", { name: /Incidents/ })).toBeChecked();
  const listBox = await page.locator("#slo-dips-repo-list").boundingBox();
  const addBox = await page.locator("#slo-dips-add-repo").boundingBox();
  expect(addBox.y).toBeGreaterThanOrEqual(listBox.y + listBox.height);
  expect(
    Math.abs(addBox.x + addBox.width / 2 - (listBox.x + listBox.width / 2)),
  ).toBeLessThanOrEqual(1);

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
        .map(({ id, name, emoji, emoji_url }) => ({ id, name, emoji, emoji_url })),
    },
  ];
  await openSloDips(page, fixtures);

  const source = page.locator('#slo-dips-repo-list [data-repo-id="9001"]');
  await source.click();

  const content = page.locator("#slo-dips-content");
  await expect(content.locator("#slo-editor-heading")).toBeFocused();
  await expect(content.getByRole("checkbox", { name: /SLO Dips/ })).toBeChecked();
  await expect(content.getByRole("checkbox", { name: /Incidents/ })).toBeChecked();
  await content.getByRole("checkbox", { name: /SLO Dips/ }).uncheck();
  await content.getByRole("checkbox", { name: /Announcements/ }).check();
  await content.getByRole("button", { name: "Save categories" }).click();

  await expect(content.getByRole("button", { name: "Save categories" })).toBeFocused();
  await expect(content.getByRole("checkbox", { name: /SLO Dips/ })).not.toBeChecked();
  await expect(content.getByRole("checkbox", { name: /Incidents/ })).toBeChecked();
  await expect(content.getByRole("checkbox", { name: /Announcements/ })).toBeChecked();

  await source.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove repository" }).click();
  await page.getByRole("menuitem", { name: "Confirm: remove Octo/Reliability" }).click();
  await expect(page.locator("#slo-dips-repo-list")).toContainText("No repositories yet.");
  await expect(page.locator("#slo-dips-add-repo")).toBeFocused();
});

test("keeps inline add state on validation errors and can return to the module placeholder", async ({
  page,
}) => {
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
  const content = page.locator("#slo-dips-content");
  await content.getByLabel("Repository").fill("octo/empty");
  await content.getByRole("button", { name: "Continue" }).click();
  await expect(content.getByRole("alert")).toContainText("no GitHub Discussion categories");
  await expect(content.getByRole("alert")).toBeFocused();
  await expect(content.getByLabel("Repository")).toHaveValue("octo/empty");

  await content.getByRole("button", { name: "Cancel" }).click();
  await expect(content.locator(".module-placeholder-title")).toHaveText(
    "Add a repository to begin.",
  );
  await expect(page.locator("#slo-dips-add-repo")).toBeFocused();
});

test("shows a compact spinner while validating a repository", async ({ page }) => {
  const fixtures = defaultFixtures();
  fixtures.sloDipsInspectDelayMs = 300;
  await openSloDips(page, fixtures);

  await page.locator("#slo-dips-add-repo").click();
  const content = page.locator("#slo-dips-content");
  await content.getByLabel("Repository").fill("octo/reliability");
  await content.getByRole("button", { name: "Continue" }).click();

  const spinner = content.locator('[data-editor-action="inspect"] .spinner--button');
  await expect(spinner).toBeVisible();
  const box = await spinner.boundingBox();
  expect(box.width).toBeLessThanOrEqual(15);
  expect(box.height).toBeLessThanOrEqual(15);
  await expect(content.getByRole("group", { name: "Discussion categories" })).toBeVisible();
});

test("cancels an existing repository load without allowing its stale response to reopen", async ({
  page,
}) => {
  const fixtures = defaultFixtures();
  fixtures.sloDipsRepos = [
    {
      ...fixtures.sloDipsCatalog["octo/reliability"].repository,
      categories: fixtures.sloDipsCatalog["octo/reliability"].categories.slice(0, 1),
    },
  ];
  fixtures.sloDipsInspectDelayMs = 300;
  await openSloDips(page, fixtures);

  await page.locator('#slo-dips-repo-list [data-repo-id="9001"]').click();
  const content = page.locator("#slo-dips-content");
  await expect(content.getByText("Loading Discussion categories")).toBeVisible();
  await content.getByRole("button", { name: "Cancel" }).click();

  await expect(content.locator(".module-placeholder-title")).toHaveText("Select a repository.");
  await page.waitForTimeout(350);
  await expect(content.locator(".module-placeholder-title")).toHaveText("Select a repository.");
});

test("confirms before switching away from unsaved category changes", async ({ page }) => {
  const fixtures = defaultFixtures();
  const reliability = fixtures.sloDipsCatalog["octo/reliability"];
  fixtures.sloDipsCatalog["octo/platform"] = {
    repository: {
      ...reliability.repository,
      id: 9002,
      full_name: "Octo/Platform",
      name: "Platform",
    },
    categories: reliability.categories,
  };
  fixtures.sloDipsRepos = [
    {
      ...reliability.repository,
      categories: reliability.categories.slice(0, 1),
    },
    {
      ...fixtures.sloDipsCatalog["octo/platform"].repository,
      categories: reliability.categories.slice(1, 2),
    },
  ];
  await openSloDips(page, fixtures);

  const reliabilitySource = page.locator('#slo-dips-repo-list [data-repo-id="9001"]');
  const platformSource = page.locator('#slo-dips-repo-list [data-repo-id="9002"]');
  const content = page.locator("#slo-dips-content");
  await reliabilitySource.click();
  await content.getByRole("checkbox", { name: /Incidents/ }).check();

  await platformSource.click();
  await expect(page.getByRole("menuitem", { name: "Discard category changes" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  await expect(reliabilitySource).toHaveAttribute("aria-current", "true");
  await expect(content.getByRole("checkbox", { name: /Incidents/ })).toBeChecked();

  await platformSource.click();
  await page.getByRole("menuitem", { name: "Discard category changes" }).click();
  await expect(platformSource).toHaveAttribute("aria-current", "true");
  await expect(content.locator("#slo-editor-heading")).toHaveText(/Octo\/Platform/);
});
