import { analyticsSpecialist } from "./analytics.ts";
import { copywriterStep } from "./copywriter.ts";
import { researchSpecialist } from "./research.ts";
import { reviewStep } from "./review.ts";
import { registerSpecialist, registerStepHandler } from "./runner.ts";
import { strategySpecialist } from "./strategy.ts";
import { visualStep } from "./visual.ts";

/**
 * Registers every specialist with the runner: the model specialists and the
 * executor steps (copywriter, visual) that reuse Orbit's generation paths
 * and the review step, which runs its own model turns between checks.
 * The worker calls this once at start; a later registration of a role
 * replaces an earlier one.
 */
export function registerAgentSpecialists() {
  registerSpecialist(analyticsSpecialist);
  registerSpecialist(researchSpecialist);
  registerSpecialist(strategySpecialist);
  registerStepHandler("copywriter", copywriterStep);
  registerStepHandler("visual", visualStep);
  registerStepHandler("review", reviewStep);
}
