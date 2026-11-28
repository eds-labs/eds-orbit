import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { seoSwitchedOn } from "./gate.ts";
import {
  googleSearchConsoleOAuthStateCleanup,
  seoConnectionProviders,
} from "./provider/index.ts";
import { seoRoutes } from "./routes.ts";
import { seoInstructions, seoTools } from "./tools.ts";

export const seoContributions: ModuleContributions = {
  available: seoSwitchedOn,
  unavailableCode: "SEO_DISABLED",
  routes: seoRoutes,
  connections: { providers: seoConnectionProviders },
  periodic: [googleSearchConsoleOAuthStateCleanup],
  tools: seoTools,
  assistant: { features: () => ["seo"], instructions: () => seoInstructions },
};
