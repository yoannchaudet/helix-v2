# AGENT.md — Helix Engineering Philosophy 🧬

This file is the shared guardrail for anyone working on Helix — human or AI. Read it
before making changes. It encodes *how* we build, not *what* we build (see
[`docs/design.md`](docs/design.md) for the design).

## Principles

### 1. Lightweight first
- Prefer the simplest solution that works. Avoid unnecessary dependencies.
- Every new dependency must earn its place — justify it over a small amount of code we
  own and understand.
- Don't over-engineer. Build for today's requirement, not an imagined future one.

### 2. Performance, without premature optimization
- Prefer performant designs by default (efficient queries, minimal work on the hot path).
- But **don't pre-optimize**. We optimize what is *measurably* slow, not what we guess
  might be slow. Measure first.

### 3. API discipline
When we call the GitHub API:
- **Use the latest API and the official docs as the source of truth.** Never invent or
  assume a schema. Reference the official GitHub REST documentation at
  <https://docs.github.com/en/rest> — append `.md` to any docs URL to fetch the
  Markdown version of that API surface (e.g.
  <https://docs.github.com/en/rest/activity/notifications.md>). Always target the
  current API version.
- **Always handle errors** — no silent failures. Surface actionable messages to the UI.
- **Honor rate limits** — read `X-RateLimit-Remaining` / `X-RateLimit-Reset` (and
  `Retry-After`) headers and back off accordingly.
- **Always paginate** — follow `Link` headers; never assume a single page.
- **Polling is configurable** — any polling interval lives in app settings, never
  hard-coded.

### 4. Offline-first, SQLite as the source of truth
- SQLite is **always** the primary application state. The UI reads from SQLite.
- The app works without a network and loads fast.
- Mutations go through the API, then we **reconcile** the result back into SQLite.
  Local state and remote state are kept consistent through reconciliation, not by
  treating the network as the live source.

### 5. UI/UX — beautiful, modern, alive
- **Vanilla CSS + modern HTML.** No heavy frameworks.
- Clear typography and a beautiful, considered layout are requirements, not polish.
- **Live feedback everywhere.** If something is loading, there is a loading animation
  somewhere visible. The user is never left guessing about async state.
- **Color-code state consistently:**
  - 🟢 **green** = success
  - 🟡 **yellow** = pending / in-progress
  - 🔴 **red** = error

## Definition of done
A change is done when it: works offline against SQLite, handles API errors and rate
limits, paginates, gives the user live visual feedback, follows the color conventions,
and adds no unjustified dependency.

## Change workflow
Every change follows the same loop:

1. **Rubber-duck it.** Before opening a PR, have the change reviewed (rubber-duck pass)
   to catch bugs, logic errors, and design flaws.
2. **Open the PR.** Branch off a fresh `main`, commit, and open a pull request.
3. **Track Copilot review.** Request the Copilot reviewer and monitor the PR for its
   comments.
4. **Decide whether to iterate.** Read Copilot's feedback and judge whether it warrants
   changes. Iterate on the PR if it does; otherwise leave it as-is. Not every comment
   requires a change — use judgment.

