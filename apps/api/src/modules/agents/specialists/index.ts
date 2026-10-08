import { analyticsSpecialist } from "./analytics.ts";
import { researchSpecialist } from "./research.ts";
import { registerSpecialist } from "./runner.ts";

/**
 * Registers every model specialist with the runner. The worker calls this
 * once at start; a later registration of a role replaces an earlier one.
 */
export function registerAgentSpecialists() {
  registerSpecialist(analyticsSpecialist);
  registerSpecialist(researchSpecialist);
}
