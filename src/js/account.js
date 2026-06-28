/* Account / authentication: the Settings → Account group (sign in with a PAT, sign out,
   show the signed-in identity) and the source of truth for whether the app is
   authenticated.

   This module owns `authenticated` (read elsewhere via `isAuthenticated()`) but does NOT
   reach into the sync/poll machinery directly. Instead it fires the hooks set via
   `configureAccount`, so main.js wires the auth transitions to polling without a circular
   import. */

import { invoke } from "./api.js";
import { $, html, rawHtml } from "./dom.js";

/** True once the user is authenticated; drives the signed-out empty state and gates the
 *  poll/sync flows (read via `isAuthenticated`). */
let authenticated = false;
/** True when the backend stores the PAT unencrypted in SQLite (debug builds) rather than
 *  the Keychain; drives the dev-build warning. */
let unencryptedStorage = false;

/** Auth-transition hooks, supplied by main.js (see `configureAccount`). Kept as no-ops so
 *  the module is usable before configuration. */
let onAuthenticated = () => {};
let onSignedOut = () => {};

/** Whether the app currently has a verified token. */
export function isAuthenticated() {
  return authenticated;
}

/** Wire the auth transitions. `onAuthenticated(justSignedIn)` fires whenever the signed-in
 *  view renders (launch restore or a fresh sign-in — `justSignedIn` distinguishes them);
 *  `onSignedOut()` fires when the signed-out view renders. */
export function configureAccount({ onAuthenticated: onIn, onSignedOut: onOut } = {}) {
  if (onIn) onAuthenticated = onIn;
  if (onOut) onSignedOut = onOut;
}

/** Markup for the "token stored unencrypted" warning shown in debug builds, or "" in
 *  release. Rendered inside the Account group so it sits next to the credential UI. */
function unencryptedStorageWarning() {
  if (!unencryptedStorage) return "";
  return html`
    <div class="callout callout--warn" role="note">
      <strong>Dev build:</strong> your GitHub token is stored
      <strong>unencrypted</strong> in this app's local database (SQLite), not the macOS
      Keychain. Use a low-privilege token and don't ship this build.
    </div>`;
}

function renderSignedIn(login, name, justSignedIn = false) {
  authenticated = true;
  // Signed in → let main start the automatic poll loop (and, on a fresh sign-in, refresh
  // the cached login + sync status). Decoupled via the hook to avoid importing sync here.
  onAuthenticated(justSignedIn);
  // Treat a missing or placeholder login as "no avatar": fetching
  // github.com/(unknown).png would 404 and the fallback letter would be "(".
  const hasLogin = Boolean(login) && login !== "(unknown)";
  const hasName = Boolean(name);
  const primary = hasName ? name : hasLogin ? `@${login}` : "Signed in";
  const secondary =
    hasName && hasLogin ? html`<span class="account-login">@${login}</span>` : "";
  const avatar = hasLogin
    ? html`<img class="avatar" id="account-avatar" alt=""
        src="https://github.com/${encodeURIComponent(login)}.png?size=96" />`
    : html`<span class="avatar avatar--fallback" aria-hidden="true">?</span>`;
  $("#account-body").innerHTML = html`
    ${rawHtml(unencryptedStorageWarning())}
    <div class="srow srow--account">
      ${rawHtml(avatar)}
      <div class="account-meta">
        <span class="account-name">${primary}</span>
        ${rawHtml(secondary)}
      </div>
      <button type="button" class="btn" id="sign-out">Sign out</button>
    </div>`;

  // Graceful fallback to an initial-letter chip if the avatar image can't load.
  const img = $("#account-avatar");
  if (img) {
    img.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "avatar avatar--fallback";
      fallback.setAttribute("aria-hidden", "true");
      fallback.textContent = login.charAt(0);
      img.replaceWith(fallback);
    });
  }
  $("#sign-out").addEventListener("click", signOut);
}

function renderSignedOut(message) {
  authenticated = false;
  // Signed out → let main stop polling (and reset the per-session sync flag).
  onSignedOut();
  const storageNote = unencryptedStorage
    ? html`Stored <strong>unencrypted</strong> in this app's local database (dev build).`
    : "Stored in your macOS Keychain.";
  $("#account-body").innerHTML = html`
    ${rawHtml(unencryptedStorageWarning())}
    <form id="signin-form" class="form">
      <div class="field">
        <label for="pat">GitHub Personal Access Token</label>
        <input id="pat" name="pat" type="password" autocomplete="off"
          placeholder="ghp_… or github_pat_…" />
        <p class="hint">
          Needs the <code>notifications</code> scope (add <code>repo</code> for private
          repositories). ${rawHtml(storageNote)}
        </p>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn--primary" id="signin-btn">Connect</button>
        <span class="form-msg ${message ? "form-msg--error" : ""}" id="signin-msg">
          ${message ?? ""}
        </span>
      </div>
    </form>`;
  $("#signin-form").addEventListener("submit", signIn);
}

async function signIn(event) {
  event.preventDefault();
  const token = $("#pat").value;
  const btn = $("#signin-btn");
  const msg = $("#signin-msg");

  btn.disabled = true;
  msg.className = "form-msg";
  msg.textContent = "Verifying with GitHub…";

  try {
    const user = await invoke("sign_in", { token });
    renderSignedIn(user.login, user.name, true);
  } catch (err) {
    renderSignedOut(String(err));
  }
}

async function signOut() {
  try {
    await invoke("sign_out");
  } catch (err) {
    // Even on error, fall back to the signed-out view.
    console.error(err);
  }
  renderSignedOut();
}

/** Read the cached auth state and render the Account group accordingly. */
export async function loadAccount() {
  const body = $("#account-body");
  body.classList.remove("slist--error");
  try {
    const status = await invoke("auth_status");
    unencryptedStorage = Boolean(status.unencrypted_storage);
    // The "stored in the macOS Keychain" footer is only true for release builds.
    const keychainNote = $("#keychain-note");
    if (keychainNote) keychainNote.hidden = unencryptedStorage;
    if (status.authenticated && status.login) {
      renderSignedIn(status.login);
    } else if (status.authenticated) {
      renderSignedIn("(unknown)");
    } else {
      renderSignedOut();
    }
  } catch (err) {
    body.classList.add("slist--error");
    body.innerHTML = html`<div class="srow"><span class="srow-error">${err}</span></div>`;
  }
}
