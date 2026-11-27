export const appearanceModes = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof appearanceModes)[number];

export const appearanceStorageKey = "orbit.appearance";

export function appearanceMode(
  value: string | null | undefined,
): AppearanceMode {
  return value === "light" || value === "dark" ? value : "system";
}

// Static and independent of React. The browser applies a saved override before
// painting the page. Without an override, CSS follows the system preference.
export const appearanceBootstrap = `
  try {
    const mode = localStorage.getItem(${JSON.stringify(appearanceStorageKey)});
    if (mode === "light" || mode === "dark") {
      document.documentElement.dataset.appearance = mode;
    }
  } catch {
    // Storage can be unavailable. Keep the system appearance.
  }
`;
