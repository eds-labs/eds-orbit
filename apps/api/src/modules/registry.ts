import {
  validateRegistry,
  type ServerModule,
  type ValidatedRegistry,
} from "../../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../platform/modules/platform-declaration.ts";
import { knowledgeModule } from "./knowledge/manifest.ts";
import { marketingModule } from "./marketing/manifest.ts";
import { marketingContributions } from "./marketing/contributions.ts";
import { knowledgeContributions } from "./knowledge/contributions.ts";
import {
  registerContributions,
  type ModuleContributions,
} from "../platform/modules/contributions.ts";
import { platformContributions } from "../platform/modules/platform-contributions.ts";

/**
 * The static module registry (ADR 0009, AD-01). The API and the worker are
 * the only importers; both validate it when they start.
 */
export const modules: readonly ServerModule[] = [
  knowledgeModule,
  marketingModule,
];

type ExtraModule = {
  module: ServerModule;
  contributions: ModuleContributions;
};
// Modules that exist only in tests (WP4.1); empty in the API and the worker.
let testModules: readonly ExtraModule[] = [];

/**
 * Test hook (WP4.1): adds modules that exist only in tests, such as the
 * fixture module that proves a third module plugs in through the contracts.
 * The API and the worker never call it.
 */
export function registerTestModules(extra: readonly ExtraModule[]) {
  testModules = extra;
  validated = undefined;
}

let validated: ValidatedRegistry | undefined;
/** The validated registry; throws MODULE_REGISTRY_INVALID on a broken manifest. */
export function moduleRegistry(): ValidatedRegistry {
  validated ??= validateRegistry(
    [...modules, ...testModules.map((m) => m.module)],
    platformDeclaration,
  );
  return validated;
}

/**
 * Validates the registry and registers every module's contributions with
 * the platform. The API, the worker and the test setup call it at startup.
 */
export function registerModules(): ValidatedRegistry {
  const registry = moduleRegistry();
  registerContributions(registry, platformContributions, {
    knowledge: knowledgeContributions,
    marketing: marketingContributions,
    ...Object.fromEntries(
      testModules.map((m) => [m.module.id, m.contributions]),
    ),
  });
  return registry;
}
