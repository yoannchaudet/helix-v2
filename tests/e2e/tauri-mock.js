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
    dependabot: JSON.parse(JSON.stringify(fixtures.dependabot ?? [])),
    mergeOperations: JSON.parse(JSON.stringify(fixtures.mergeOperations ?? [])),
    mergeOperationDetails: JSON.parse(JSON.stringify(fixtures.mergeOperationDetails ?? {})),
    dependabotLastSync: fixtures.dependabotLastSync ?? null,
    lastModule: fixtures.lastModule ?? null,
    // When true, `get_dependabot_merge_operation_detail` calls don't resolve on their own —
    // they queue in `pendingDetailCalls` for a spec to resolve explicitly (in any order) via
    // `window.__mockResolvePendingDetail`. Lets a spec exercise the "a stale detail response
    // must not overwrite newer state" defense deterministically.
    deferDetailResolution: Boolean(fixtures.deferDetailResolution),
    pendingDetailCalls: [],
  };
  window.__TAURI_CALLS__ = [];

  // Test hook: resolve one queued `get_dependabot_merge_operation_detail` call (FIFO by
  // default, or by explicit index) when `deferDetailResolution` is on. Resolves with a fresh
  // read through the real handler (so it reflects whatever the operation/state looks like at
  // resolution time, not at call time) unless `overrideResult` is given.
  window.__mockResolvePendingDetail = (index = 0, overrideResult) => {
    const call = state.pendingDetailCalls.splice(index, 1)[0];
    if (!call) return false;
    try {
      call.resolve(
        overrideResult !== undefined
          ? overrideResult
          : handlers.get_dependabot_merge_operation_detail(call.args),
      );
    } catch (err) {
      call.reject(err);
    }
    return true;
  };
  window.__mockPendingDetailCount = () => state.pendingDetailCalls.length;

  // Minimal event bus mirroring Tauri's listen/emit. Handlers can `emit(name, payload)` to
  // drive the app's event-driven flows (e.g. the subject-resolution lifecycle after a sync).
  const listeners = new Map();
  const emit = (name, payload) => {
    for (const cb of listeners.get(name) ?? []) cb({ payload });
  };
  const listen = (name, cb) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return Promise.resolve(() => listeners.get(name)?.delete(cb));
  };
  // Test hook: let specs drive backend events directly (e.g. finish a withheld resolution pass).
  window.__mockEmit = emit;

  const activeMergeStates = new Set(["queued", "validating", "delegated", "cancel_requested"]);
  const recomputeMergeQueuePositions = () => {
    const byRepo = new Map();
    for (const operation of state.mergeOperations) {
      operation.queue_position = null;
      if (!activeMergeStates.has(operation.state)) continue;
      const queue = byRepo.get(operation.repo_full_name) ?? [];
      queue.push(operation);
      byRepo.set(operation.repo_full_name, queue);
    }
    for (const queue of byRepo.values()) {
      queue
        .sort(
          (a, b) =>
            String(a.enqueued_at).localeCompare(String(b.enqueued_at)) ||
            Number(a.id) - Number(b.id),
        )
        .forEach((operation, index) => {
          operation.queue_position = index + 1;
        });
    }
  };

  // Test hook: patch a merge operation (and optionally its stored detail payload) in place,
  // then fire `dependabot:operations-changed` — the app's own live-refresh event — so a spec
  // can simulate a phase transition / retry / queue-position update / new action-log event
  // without re-implementing the backend's processing state machine.
  window.__mockSetOperation = (operationId, patch = {}, detailPatch = undefined) => {
    const operation = state.mergeOperations.find((o) => o.id === operationId);
    if (operation) {
      Object.assign(operation, patch);
      recomputeMergeQueuePositions();
    }
    if (detailPatch !== undefined) {
      const key = String(operationId);
      const existing = state.mergeOperationDetails[key] ?? {};
      state.mergeOperationDetails[key] = {
        ...existing,
        ...detailPatch,
        operation: { ...(operation ?? existing.operation), ...(detailPatch.operation ?? {}) },
      };
    }
    emit("dependabot:operations-changed", null);
  };

  // Test hook: replace the mock dependabot groups entirely — lets a spec simulate a repo
  // vanishing between snapshots (e.g. after a sync removes a repo that no longer has PRs).
  window.__mockSetDependabot = (newGroups) => {
    state.dependabot = JSON.parse(JSON.stringify(newGroups));
  };

  const countAll = () => state.inbox.reduce((sum, g) => sum + g.notifications.length, 0);

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
    save_settings: ({ pollIntervalS, dependabotMergePollIntervalS }) => {
      state.settings.poll_interval_s = pollIntervalS;
      state.settings.dependabot_merge_poll_interval_s = dependabotMergePollIntervalS;
      return { ...state.settings, theme: state.theme };
    },
    set_theme: ({ theme }) => {
      state.theme = theme;
      return null;
    },
    get_last_module: () => state.lastModule ?? null,
    set_last_module: ({ moduleId }) => {
      state.lastModule = moduleId;
      return null;
    },

    list_inbox: () => JSON.parse(JSON.stringify(state.inbox)),
    list_bookmarks: () => {
      // is_done is derived: a bookmark not present in the live inbox is done/removed.
      const inboxIds = new Set(state.inbox.flatMap((g) => g.notifications.map((n) => n.thread_id)));
      const groups = (state.bookmarks ?? []).map((g) => ({
        ...g,
        notifications: g.notifications.map((n) => ({
          ...n,
          is_done: !inboxIds.has(n.thread_id),
        })),
      }));
      return JSON.parse(JSON.stringify(groups));
    },
    set_bookmark: ({ threadId, bookmarked }) => {
      state.bookmarks = state.bookmarks ?? [];
      let snapshot = null;
      for (const g of state.inbox) {
        for (const n of g.notifications) {
          if (n.thread_id === threadId) {
            n.bookmarked = bookmarked;
            snapshot = { group: g, n };
          }
        }
      }
      if (bookmarked && snapshot) {
        // Snapshot into a standalone dataset so it persists after the row is marked done.
        let bg = state.bookmarks.find((g) => g.repo_id === snapshot.group.repo_id);
        if (!bg) {
          bg = { ...snapshot.group, notifications: [] };
          state.bookmarks.push(bg);
        }
        if (!bg.notifications.some((x) => x.thread_id === threadId)) {
          bg.notifications.push({ ...snapshot.n, bookmarked: true });
        }
      } else {
        state.bookmarks = state.bookmarks
          .map((g) => ({
            ...g,
            notifications: g.notifications.filter((x) => x.thread_id !== threadId),
          }))
          .filter((g) => g.notifications.length);
      }
      return null;
    },
    sync_now: () => {
      // Mirror the backend: the list sync returns immediately, then a background subject
      // resolution pass runs and reports completion. No pending subjects in the mock, so it
      // resolves nothing — but the lifecycle events still fire so the app leaves the
      // "Syncing…" (resolving) phase. A macrotask defers them until after the app's
      // `await invoke(...)` continuation, modelling the real (post-return) ordering.
      //
      // With `fixtures.manualResolution`, the `-done` event is withheld so a test can observe
      // the "busy through resolution" phase and then fire it via `window.__mockEmit(...)`.
      setTimeout(() => {
        emit("subjects:resolution-started", null);
        if (!fixtures.manualResolution) emit("subjects:resolution-done", { changed: 0 });
      }, 0);
      return { count: countAll(), removed: 0 };
    },
    list_dependabot: () => {
      const activeByPr = new Map(
        state.mergeOperations
          .filter((o) => activeMergeStates.has(o.state))
          .map((o) => [
            o.pr_id,
            { id: o.id, state: o.state, queue_position: o.queue_position ?? null },
          ]),
      );
      return JSON.parse(
        JSON.stringify(
          state.dependabot.map((group) => ({
            ...group,
            prs: group.prs.map((pr) => ({
              ...pr,
              active_merge_operation: activeByPr.get(pr.id) ?? null,
            })),
          })),
        ),
      );
    },
    list_dependabot_merge_operations: () => JSON.parse(JSON.stringify(state.mergeOperations)),
    get_dependabot_merge_operation_detail: ({ operationId }) => {
      const operation = state.mergeOperations.find((candidate) => candidate.id === operationId);
      if (!operation) throw new Error("Merge operation not found");
      const stored = state.mergeOperationDetails[String(operationId)];
      // Always reflect the *current* operation snapshot (phase/strategy/retry/queue fields may
      // have moved on since a detail payload was stored/seeded), while events/explanation/next
      // action come from the stored payload (if any) or a sensible default.
      return JSON.parse(
        JSON.stringify({
          operation,
          events: stored?.events ?? [
            {
              id: operationId,
              operation_id: operationId,
              phase: operation.phase ?? operation.state,
              kind: "operation",
              status: "waiting",
              summary: "Merge operation queued.",
              detail: null,
              head_sha: null,
              external_id: null,
              created_at: operation.enqueued_at,
            },
          ],
          current_explanation:
            stored?.current_explanation ?? "Waiting for Helix to process this repository.",
          next_action: stored?.next_action ?? "Validate the pull request.",
        }),
      );
    },
    dependabot_merge_status: () => ({
      active_count: state.mergeOperations.filter((o) => activeMergeStates.has(o.state)).length,
      poll_interval_s: state.settings.dependabot_merge_poll_interval_s,
      min_poll_interval_s: state.settings.min_dependabot_merge_poll_interval_s,
      github_poll_floor_s: 0,
      backoff_until: null,
      last_error: null,
    }),
    enqueue_dependabot_merge: ({ prId }) => {
      const existing = state.mergeOperations.find(
        (o) => o.pr_id === prId && activeMergeStates.has(o.state),
      );
      if (existing) return { ...existing };
      let found;
      for (const group of state.dependabot) {
        const pr = group.prs.find((candidate) => candidate.id === prId);
        if (pr) found = { group, pr };
      }
      if (!found) throw new Error("Dependabot PR not found");
      const operation = {
        id: Math.max(0, ...state.mergeOperations.map((o) => o.id)) + 1,
        pr_id: prId,
        repo_full_name: found.group.full_name,
        number: found.pr.number,
        title: found.pr.title,
        html_url: found.pr.html_url,
        base_ref: found.pr.base_ref ?? null,
        state: "queued",
        phase: "queued",
        strategy: "unknown",
        queue_position: null,
        check_retry_count: 0,
        merge_queue_position: null,
        next_action_at: null,
        failure_reason: null,
        last_error: null,
        enqueued_at: new Date().toISOString(),
        delegated_at: null,
        terminal_at: null,
      };
      state.mergeOperations.push(operation);
      recomputeMergeQueuePositions();
      state.mergeOperationDetails[String(operation.id)] = {
        operation,
        events: [
          {
            id: operation.id,
            operation_id: operation.id,
            phase: "queued",
            kind: "operation",
            status: "waiting",
            summary: "Merge operation queued.",
            detail: null,
            head_sha: null,
            external_id: null,
            created_at: operation.enqueued_at,
          },
        ],
        current_explanation: "Waiting for Helix to process this repository.",
        next_action: "Validate the pull request.",
      };
      emit("dependabot:operations-changed", null);
      return { ...operation };
    },
    cancel_dependabot_merge: ({ operationId }) => {
      const operation = state.mergeOperations.find((o) => o.id === operationId);
      if (!operation) throw new Error("Merge operation not found");
      operation.state = operation.state === "queued" ? "cancelled" : "cancel_requested";
      operation.queue_position = null;
      if (operation.state === "cancelled") operation.terminal_at = new Date().toISOString();
      recomputeMergeQueuePositions();
      emit("dependabot:operations-changed", null);
      return { ...operation };
    },
    discard_dependabot_pr: ({ prId }) => {
      const operation = state.mergeOperations.find(
        (candidate) => candidate.pr_id === prId && activeMergeStates.has(candidate.state),
      );
      if (operation) {
        operation.state = operation.state === "queued" ? "cancelled" : "cancel_requested";
        operation.queue_position = null;
        if (operation.state === "cancelled") operation.terminal_at = new Date().toISOString();
        recomputeMergeQueuePositions();
        emit("dependabot:operations-changed", null);
        if (operation.state !== "cancelled") {
          return { status: "cancelling", pr_id: prId, operation_id: operation.id };
        }
      }
      if (fixtures.discardError) throw new Error(fixtures.discardError);
      if (fixtures.discardOutcome === "merged") {
        throw new Error("The pull request merged before Helix could discard it.");
      }
      let removed = false;
      state.dependabot = state.dependabot
        .map((group) => {
          const prs = group.prs.filter((pr) => {
            if (pr.id !== prId) return true;
            removed = true;
            return false;
          });
          return { ...group, total: prs.length, prs };
        })
        .filter((group) => group.prs.length);
      if (!removed) throw new Error("Dependabot PR not found");
      emit("dependabot:changed", { pr_id: prId });
      return {
        status: "closed",
        pr_id: prId,
        operation_id: operation?.id ?? null,
      };
    },
    process_dependabot_merges: () => {
      const delegatedRepos = new Set(
        state.mergeOperations.filter((o) => o.state === "delegated").map((o) => o.repo_full_name),
      );
      for (const operation of state.mergeOperations) {
        if (operation.state === "queued" && !delegatedRepos.has(operation.repo_full_name)) {
          operation.state = "delegated";
          operation.phase = "validating";
          operation.delegated_at = new Date().toISOString();
          delegatedRepos.add(operation.repo_full_name);
        } else if (operation.state === "cancel_requested") {
          operation.state = "cancelled";
          operation.terminal_at = new Date().toISOString();
        }
      }
      recomputeMergeQueuePositions();
      emit("dependabot:operations-changed", null);
      return handlers.dependabot_merge_status();
    },
    dependabot_status: () => ({ last_sync_at: state.dependabotLastSync ?? null }),
    sync_dependabot: () => ({
      count: state.dependabot.reduce((sum, g) => sum + g.prs.length, 0),
      removed: 0,
      rate_remaining: 28,
      complete: true,
    }),
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
        if (cmd === "get_dependabot_merge_operation_detail" && state.deferDetailResolution) {
          // Held open until a spec resolves it (in any order) via
          // `window.__mockResolvePendingDetail` — see the stale-response-defense spec.
          return new Promise((resolve, reject) => {
            state.pendingDetailCalls.push({ args: args || {}, resolve, reject });
          });
        }
        const handler = handlers[cmd];
        return handler
          ? Promise.resolve(handler(args || {}))
          : Promise.reject(new Error(`unmocked Tauri command: ${cmd}`));
      },
    },
    // Event bus backing the app's listen()/emit() flows (see the top of this fn).
    event: { listen: (name, cb) => listen(name, cb) },
  };
}

/** A signed-in inbox with two repos and a spread of reasons/states, so the smart filters,
 *  repo refinement, and cleanup candidacy all have something to match. */
export function defaultFixtures() {
  return {
    auth: { authenticated: true, login: "octocat", unencrypted_storage: false },
    // A long poll interval keeps the automatic poll loop from firing a sync mid-test.
    settings: {
      poll_interval_s: 3600,
      min_poll_interval_s: 10,
      dependabot_merge_poll_interval_s: 3600,
      min_dependabot_merge_poll_interval_s: 30,
      theme: "system",
    },
    db: {
      path: "/Users/test/Library/Application Support/helix/helix.db",
      schema_version: 15,
      tables: [
        "bookmarks",
        "dependabot_merge_check_retries",
        "dependabot_merge_operation_events",
        "dependabot_merge_operations",
        "dependabot_merge_policies",
        "dependabot_merge_runtime",
        "dependabot_prs",
        "dependabot_repos",
        "done_tombstones",
        "notifications",
        "rate_limits",
        "repos",
        "settings",
        "sync_state",
      ],
    },
    syncStatus: {
      last_sync_at: "2026-06-27T11:30:00Z",
      last_status: "success",
      last_error: null,
      github_poll_interval_s: 60,
      rate_buckets: [{ resource: "core", limit: 5000, remaining: 4800, reset_at: 4102444800 }],
    },
    appVersion: "0.1.0",
    updaterEnabled: false,
    dependabot: [
      {
        full_name: "octo/hello",
        total: 2,
        prs: [
          {
            id: 101,
            number: 40,
            title: "Bump lodash from 4.17.20 to 4.17.21",
            html_url: "https://github.com/octo/hello/pull/40",
            author: "dependabot[bot]",
            base_ref: "main",
            updated_at: "2026-06-27T10:30:00Z",
            mergeable_state: "clean",
          },
          {
            id: 102,
            number: 41,
            title: "Bump actions/checkout from 4 to 5",
            html_url: "https://github.com/octo/hello/pull/41",
            author: "dependabot[bot]",
            base_ref: "release/v2",
            updated_at: "2026-06-27T09:30:00Z",
            mergeable_state: "blocked",
          },
        ],
      },
      {
        full_name: "acme/widgets",
        total: 1,
        prs: [
          {
            id: 103,
            number: 9,
            title: "Bump serde from 1.0.0 to 1.0.1",
            html_url: "https://github.com/acme/widgets/pull/9",
            author: "dependabot[bot]",
            base_ref: "develop",
            updated_at: "2026-06-27T11:15:00Z",
            mergeable_state: null,
          },
        ],
      },
    ],
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
