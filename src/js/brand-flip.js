/* Brand wordmark flip: right-clicking (or pressing Enter/Space on) the top-chrome "Helix" wordmark
   flips it (3D card) to reveal the running app version for a few seconds, then flips back. Purely
   cosmetic; the version is the same value Settings shows (the `app_version` Tauri command).
   `initBrandFlip()` is the only entry point. */

import { invoke } from "./api.js";
import { $ } from "./dom.js";

/** How long the version stays revealed before flipping back, in milliseconds. */
const REVEAL_MS = 5000;

/** Bootstrap the brand flip: fetch the version once, then wire the flip toggle + auto-revert. */
export async function initBrandFlip() {
  const btn = $("#brand-flip");
  if (!btn) return;

  const frontEl = btn.querySelector(".brand-face-front");
  const backEl = $("#brand-version");

  let version = "";
  try {
    version = await invoke("app_version");
  } catch {
    version = "";
  }
  if (backEl) backEl.textContent = version ? `v${version}` : "—";

  let hideTimer = null;

  /** Apply the flipped/unflipped state, keeping the visuals and ARIA in sync so assistive tech
   *  reads the face that's actually showing (the hidden face is marked aria-hidden). */
  function setFlipped(flipped) {
    btn.classList.toggle("is-flipped", flipped);
    btn.setAttribute("aria-pressed", flipped ? "true" : "false");
    // Only the visible face should be exposed to assistive tech.
    if (frontEl) frontEl.setAttribute("aria-hidden", flipped ? "true" : "false");
    if (backEl) backEl.setAttribute("aria-hidden", flipped ? "false" : "true");
    // Surface the revealed version in the accessible name while flipped.
    btn.setAttribute(
      "aria-label",
      flipped && backEl ? `App version ${backEl.textContent}` : "Show app version",
    );

    clearTimeout(hideTimer);
    if (flipped) {
      // Auto-flip back after the reveal window. Toggling again before then cancels this timer.
      hideTimer = setTimeout(() => setFlipped(false), REVEAL_MS);
    }
  }

  btn.addEventListener("contextmenu", (e) => {
    // Trigger on right-click; suppress the native context menu so the flip is the only response.
    e.preventDefault();
    setFlipped(!btn.classList.contains("is-flipped"));
  });

  // Keyboard affordance: the button is focusable and a left-click is reserved for window drag, so
  // let Enter/Space toggle the flip for keyboard users.
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setFlipped(!btn.classList.contains("is-flipped"));
    }
  });
}
