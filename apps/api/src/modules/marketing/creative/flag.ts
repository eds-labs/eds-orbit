import { loadConfig } from "../../../../../../packages/config/src/index.ts";

/** The Creative Studio switch: off, there is no creative route, tool or UI. */
export function creativeStudioEnabled(): boolean {
  return loadConfig().ORBIT_CREATIVE_STUDIO === "true";
}
