import { loadConfig } from "../../../../../../packages/config/src/index.ts";

/** The Creative Studio switch: off, there is no creative route, tool or UI. */
export function creativeStudioEnabled(): boolean {
  return loadConfig().ORBIT_CREATIVE_STUDIO === "true";
}

/**
 * Whether a project's automatic Creative Studio behaviour is on (R65): the
 * switch and the project's own opt-in in its marketing profile data
 * (`visualIdentity.creative.enabled`, absent: off). Copy craft in
 * generation, the strategy's art plan, composing package images and
 * assignment creatives need both; the manual studio needs only the switch
 * and a brand kit.
 */
export function creativeAutomationEnabled(profile: unknown): boolean {
  const identity = (profile as { visualIdentity?: any } | null | undefined)
    ?.visualIdentity;
  return creativeStudioEnabled() && identity?.creative?.enabled === true;
}
