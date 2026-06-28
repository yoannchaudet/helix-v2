import { defineConfig, devices } from "@playwright/test";

/* Browser-based UI tests for the frontend. These load the real index.html + ES modules in
 * headless Chromium with a mocked `window.__TAURI__` (see tests/e2e/tauri-mock.js), to catch
 * large UX regressions the pure node --test suite can't. They do NOT run on the real macOS
 * WKWebView, so engine-specific quirks (the focusout/click race, clipboard) stay manual. */

const PORT = 5599;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.js",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : "line",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node tests/e2e/serve.js ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
