import { loadConfig } from "../../../../../packages/config/src/index.ts";

// Rollout of the settings center (ADR 0027), read on every call so a flag
// change needs no restart in tests. "off": nothing changes and the new routes
// answer 404. "preview": the center is reachable for every signed-in member
// (one user-menu entry, /manage); each member sees only the scopes and
// sections their role permits, and all old pages and links stay. "on":
// reserved for the step where navigation points to the center and old
// addresses redirect (phase 5); today it behaves like "preview".

export type SettingsCenterStage = "off" | "preview" | "on";

export const settingsCenterStage = (): SettingsCenterStage =>
  loadConfig().ORBIT_SETTINGS_CENTER;

/** Whether the routes below /api/management/ exist at all. */
export const settingsCenterEnabled = () => settingsCenterStage() !== "off";

/** The route pattern, not the raw URL, is what the request hook passes in. */
export const isManagementRoute = (url: string) =>
  url.startsWith("/api/management/");
