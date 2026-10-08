import { analyticsSpecialist } from "./analytics.ts";
import { copywriterStep } from "./copywriter.ts";
import { researchSpecialist } from "./research.ts";
import { registerSpecialist, registerStepHandler } from "./runner.ts";
import { strategySpecialist } from "./strategy.ts";
import { visualStep } from "./visual.ts";

/**
 * Registers every specialist with the runner: the model specialists and the
 * executor steps (copywriter, visual) that reuse Orbit's generation paths.
 * The worker calls this once at start; a later registration of a role
 * replaces an earlier one.
 */
export function registerAgentSpecialists() {
  registerSpecialist(analyticsSpecialist);
  registerSpecialist(researchSpecialist);
  registerSpecialist(strategySpecialist);
  registerStepHandler("copywriter", copywriterStep);
  registerStepHandler("visual", visualStep);
}
