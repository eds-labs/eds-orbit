import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { financeFxSync } from "./fx.ts";
import { financeSwitchedOn } from "./gate.ts";

/** What the finance module plugs into the platform; later tasks add to it. */
export const financeContributions: ModuleContributions = {
  available: financeSwitchedOn,
  periodic: [financeFxSync],
};
