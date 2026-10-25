import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { workSwitchedOn } from "./gate.ts";

/** What the project management module plugs into the platform. */
export const workContributions: ModuleContributions = {
  available: workSwitchedOn,
  unavailableCode: "WORK_DISABLED",
};
