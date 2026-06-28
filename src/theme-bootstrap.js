// Resolve the saved theme before first paint to avoid a flash of the wrong theme.
// The preference is mirrored to localStorage by main.js; SQLite remains the source of
// truth and re-confirms it once the app boots.
(function () {
  try {
    let pref = localStorage.getItem("helix-theme");
    // Fall back to "system" for missing/corrupted/unknown values so the first paint still
    // follows the OS rather than silently defaulting to light.
    if (pref !== "light" && pref !== "dark" && pref !== "system") {
      pref = "system";
    }
    const dark =
      pref === "dark" ||
      (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {}
})();
