/* Brand wordmark flip: right-clicking the top-chrome "Helix" wordmark flips it (3D card) to reveal the
   running app version for a few seconds, then flips back. Purely cosmetic; the version is the same
   value Settings shows (the `app_version` Tauri command). `initBrandFlip()` is the only entry point. */

import { invoke } from "./api.js";
import { $ } from "./dom.js";

/** How long the version stays revealed before flipping back, in milliseconds. */
const REVEAL_MS = 5000;

/** Bootstrap the brand flip: fetch the version once, then wire right-click to flip/hold/flip-back. */
export async function initBrandFlip() {
  const btn = $("#brand-flip");
  if (!btn) return;

  const verEl = $("#brand-version");
  if (verEl) {
    try {
      const version = await invoke("app_version");
      verEl.textContent = version ? `v${version}` : "—";
    } catch {
      verEl.textContent = "—";
    }
  }

  let hideTimer = null;

  btn.addEventListener("contextmenu", (e) => {
    // Trigger on right-click; suppress the native context menu so the flip is the only response.
    e.preventDefault();
    const flipped = btn.classList.toggle("is-flipped");
    // Reflect state for assistive tech: the back (version) is the meaningful content once flipped.
    btn.setAttribute("aria-pressed", flipped ? "true" : "false");

    clearTimeout(hideTimer);
    if (flipped) {
      // Auto-flip back after the reveal window. Clicking again before then simply flips back now
      // (handled by the toggle above clearing this timer).
      hideTimer = setTimeout(() => {
        btn.classList.remove("is-flipped");
        btn.setAttribute("aria-pressed", "false");
      }, REVEAL_MS);
    }
  });
}
