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

  await expect(content.locator(".module-placeholder-title")).toHaveText(
    "No SLO dips in the last 60 days.",
  );
  await page.waitForTimeout(350);
  await expect(content.locator(".module-placeholder-title")).toHaveText(
    "No SLO dips in the last 60 days.",
  );
});

test("renders collected dips grouped by repo and refreshes on demand", async ({ page }) => {
  const fixtures = defaultFixtures();
  const reliability = fixtures.sloDipsCatalog["octo/reliability"];
  fixtures.sloDipsRepos = [
    {
      ...reliability.repository,
      categories: reliability.categories.slice(0, 1),
    },
  ];
  fixtures.sloDips = [
    {
      comment_id: 16633787,
      repo_id: 9001,
      repo_full_name: "Octo/Reliability",
      discussion_number: 7585,
      discussion_title: "SLO investigations for `dns` - Week of April 13, 2026",
      service: "dns",
      comment_url: "https://github.com/octo/reliability/discussions/7585#c1",
      slo_name: "dns-global-api/availability",
      slo_url: "https://app.datadoghq.com/slo/1",
      dip_date: "2026-04-19",
      percent: 99.967,
      goal_percent: 99.99,
      investigated: true,
      investigated_by: "yoannchaudet",
      investigated_at: "2026-04-20T00:00:00Z",
      comment_created_at: "2026-04-19T00:00:00Z",
    },
    {
      comment_id: 16633788,
      repo_id: 9001,
      repo_full_name: "Octo/Reliability",
      discussion_number: 7585,
      discussion_title: "SLO investigations for `dns` - Week of April 13, 2026",
      service: "dns",
      comment_url: "https://github.com/octo/reliability/discussions/7585#c2",
      slo_name: "dns-global-api/latency",
      slo_url: null,
      dip_date: "2026-04-18",
      percent: 98.5,
      goal_percent: 99.9,
      investigated: false,
      investigated_by: null,
      investigated_at: null,
      comment_created_at: "2026-04-18T00:00:00Z",
    },
  ];
  await openSloDips(page, fixtures);

  const content = page.locator("#slo-dips-content");
  await expect(content.locator(".slo-dips-summary-total")).toHaveText("2 dips");
  const rows = content.locator(".slo-dip-row");
  await expect(rows).toHaveCount(2);
  await expect(content.locator(".slo-dip-repo-name")).toHaveText("Octo/Reliability");
  await expect(rows.first().locator(".slo-dip-badge--investigated")).toContainText(
    "investigated by yoannchaudet",
  );
  await expect(rows.nth(1).locator(".slo-dip-badge--pending")).toHaveText("pending");
  // The Datadog deep link only appears when a slo_url is present.
  await expect(rows.first().locator(".slo-dip-datadog")).toHaveCount(1);
  await expect(rows.nth(1).locator(".slo-dip-datadog")).toHaveCount(0);

  // Links open through the backend's validated `open_url` command, not raw anchors.
  await rows.first().locator(".slo-dip-link").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__TAURI_CALLS__.filter((c) => c.cmd === "open_url").map((c) => c.args.url),
      ),
    )
    .toContain("https://github.com/octo/reliability/discussions/7585#c1");

  // The manual refresh button re-fetches and repaints with whatever the backend now returns.
  await page.evaluate(() => {
    window.__mockSetSloDips([
      {
        comment_id: 16633787,
        repo_id: 9001,
        repo_full_name: "Octo/Reliability",
        discussion_number: 7585,
        discussion_title: "SLO investigations for `dns` - Week of April 13, 2026",
        service: "dns",
        comment_url: "https://github.com/octo/reliability/discussions/7585#c1",
        slo_name: "dns-global-api/availability",
        slo_url: "https://app.datadoghq.com/slo/1",
        dip_date: "2026-04-19",
        percent: 99.967,
        goal_percent: 99.99,
        investigated: true,
        investigated_by: "yoannchaudet",
        investigated_at: "2026-04-20T00:00:00Z",
        comment_created_at: "2026-04-19T00:00:00Z",
      },
    ]);
  });
  await page.locator(".js-slo-refresh-btn").click();
  await expect(content.locator(".slo-dip-row")).toHaveCount(1);
  await expect(content.locator(".slo-dips-summary-total")).toHaveText("1 dip");
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
