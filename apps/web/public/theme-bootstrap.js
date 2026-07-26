(() => {
  const systemTheme = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  let preference = "system";

  try {
    const remembered = window.localStorage.getItem("diary-theme");
    if (remembered === "system" || remembered === "light" || remembered === "dark") {
      preference = remembered;
    } else if (remembered !== null) {
      window.localStorage.setItem("diary-theme", "system");
    }
  } catch {
    // System preference remains the fallback when storage is unavailable.
  }

  const resolved = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
})();
