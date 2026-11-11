import { loadConfig } from "../../../../../packages/config/src/index.ts";

// Rollout of the settings center (ADR 0027), read on every call so a flag
// change needs no restart in tests. "preview" shows it to system
// administrators only; "on" shows it to everyone allowed to manage something.

export type SettingsCenterStage = "off" | "preview" | "on";

export const settingsCenterStage = (): SettingsCenterStage =>
  loadConfig().ORBIT_SETTINGS_CENTER;

/** Whether the routes below /api/management/ exist at all. */
export const settingsCenterEnabled = () => settingsCenterStage() !== "off";

/** The route pattern, not the raw URL, is what the request hook passes in. */
export const isManagementRoute = (url: string) =>
  url.startsWith("/api/management/");
