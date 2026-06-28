/* Mocked Tauri backend for the Playwright suite.
 *
 * `installTauriMock` is serialized by Playwright and runs IN THE BROWSER before the app's
 * scripts, defining `window.__TAURI__` (the `withGlobalTauri` surface the real app reads via
 * `src/js/api.js`). It must be fully self-contained — no imports, no closure references — and
 * receives the canned `fixtures` as its single argument.
 *
 * The mock is stateful within a page: `mark_threads_done` removes threads so a follow-up
 * `list_inbox` reflects the removal, `save_settings`/`set_theme` persist, and sign in/out
 * flip auth — mirroring how the real app round-trips through SQLite. Every call is recorded
 * on `window.__TAURI_CALLS__` for assertions. */

export function installTauriMock(fixtures) {
  const state = {
    auth: { ...fixtures.auth },
    settings: { ...fixtures.settings },
    theme: fixtures.settings.theme,
    inbox: JSON.parse(JSON.stringify(fixtures.inbox)),
  };
  window.__TAURI_CALLS__ = [];

  const countAll = () =>
    state.inbox.reduce((sum, g) => sum + g.notifications.length, 0);

  const handlers = {
    show_main_window: () => null,
    open_url: () => null,
    reveal_in_finder: () => null,
    install_update: () => null,
    check_for_update: () => null,
    updater_enabled: () => Boolean(fixtures.updaterEnabled),
    app_version: () => fixtures.appVersion,
    db_status: () => fixtures.db,
    sync_status: () => fixtures.syncStatus,

    auth_status: () => ({ ...state.auth }),
    sign_in: () => {
      state.auth = { authenticated: true, login: "octocat", unencrypted_storage: false };
      return { login: "octocat", name: "The Octocat" };
    },
    sign_out: () => {
      state.auth = { authenticated: false };
      return null;
    },

    get_settings: () => ({ ...state.settings, theme: state.theme }),
    save_settings: ({ pollIntervalS }) => {
      state.settings.poll_interval_s = pollIntervalS;
      return { ...state.settings, theme: state.theme };
    },
    set_theme: ({ theme }) => {
      state.theme = theme;
      return null;
    },

    list_inbox: () => JSON.parse(JSON.stringify(state.inbox)),
    sync_now: () => ({ count: countAll(), removed: 0 }),
    mark_threads_done: ({ threadIds }) => {
      const ids = new Set(threadIds);
      state.inbox = state.inbox
        .map((g) => ({
          ...g,
          notifications: g.notifications.filter((n) => !ids.has(n.thread_id)),
        }))
        .filter((g) => g.notifications.length);
      return { ok: threadIds.length, failed: [] };
    },
  };

  window.__TAURI__ = {
    core: {
      invoke: (cmd, args) => {
        window.__TAURI_CALLS__.push({ cmd, args: args || null });
        const handler = handlers[cmd];
        return handler
          ? Promise.resolve(handler(args || {}))
          : Promise.reject(new Error(`unmocked Tauri command: ${cmd}`));
      },
    },
    // The app subscribes to backend events but never depends on one firing during these
    // tests, so listen is a no-op returning the usual unlisten function.
    event: { listen: () => Promise.resolve(() => {}) },
  };
}

/** A signed-in inbox with two repos and a spread of reasons/states, so the smart filters,
 *  repo refinement, and cleanup candidacy all have something to match. */
export function defaultFixtures() {
  return {
    auth: { authenticated: true, login: "octocat", unencrypted_storage: false },
    // A long poll interval keeps the automatic poll loop from firing a sync mid-test.
    settings: { poll_interval_s: 3600, min_poll_interval_s: 10, theme: "system" },
    db: {
      path: "/Users/test/Library/Application Support/helix/helix.sqlite3",
      schema_version: 3,
      tables: ["notifications", "repos", "settings"],
    },
    syncStatus: {
      last_sync_at: "2026-06-27T11:30:00Z",
      last_status: "success",
      last_error: null,
      github_poll_interval_s: 60,
      rate_buckets: [
        { resource: "core", limit: 5000, remaining: 4800, reset_at: 4102444800 },
      ],
    },
    appVersion: "0.1.0",
    updaterEnabled: false,
    inbox: [
      {
        repo_id: 1,
        full_name: "octo/hello",
        private: false,
        notifications: [
          {
            thread_id: "t1",
            subject_type: "PullRequest",
            subject_title: "Add dark mode",
            subject_number: 12,
            subject_state: "open",
            subject_html_url: "https://github.com/octo/hello/pull/12",
            reason: "review_requested",
            updated_at: "2026-06-27T10:00:00Z",
          },
          {
            thread_id: "t2",
            subject_type: "Issue",
            subject_title: "Crash on launch",
            subject_number: 7,
            subject_state: "open",
            subject_html_url: "https://github.com/octo/hello/issues/7",
            reason: "mention",
            updated_at: "2026-06-27T09:00:00Z",
          },
        ],
      },
      {
        repo_id: 2,
        full_name: "acme/widgets",
        private: true,
        notifications: [
          {
            thread_id: "t3",
            subject_type: "PullRequest",
            subject_title: "Bump dependencies",
            subject_number: 3,
            subject_state: "merged",
            subject_html_url: "https://github.com/acme/widgets/pull/3",
            reason: "assign",
            updated_at: "2026-06-27T11:00:00Z",
            resolved_at: "2026-06-27T11:30:00Z",
          },
        ],
      },
    ],
  };
}

/** Signed-in but with nothing in the inbox (the "all caught up" empty state). */
export function emptyFixtures() {
  return { ...defaultFixtures(), inbox: [] };
}

/** Signed out: the inbox should show the connect-your-account hint. */
export function signedOutFixtures() {
  return {
    ...defaultFixtures(),
    auth: { authenticated: false, unencrypted_storage: false },
    inbox: [],
  };
}

/** Install the mock, load the real app, and wait for the first render to settle. */
export async function openApp(page, fixtures = defaultFixtures()) {
  await page.addInitScript(installTauriMock, fixtures);
  await page.goto("/");
  await page.waitForSelector("#inbox .repo-section, #inbox .inbox-empty");
  return page;
}
