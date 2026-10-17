import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { ModuleContributions } from "../../platform/modules/contributions.ts";

/** True while support is switched on for this installation (ORBIT_SUPPORT). */
export const supportSwitchedOn = () => loadConfig().ORBIT_SUPPORT === "true";

/** What the support module plugs into the platform (WP5.1). */
export const supportContributions: ModuleContributions = {
  available: supportSwitchedOn,
};
