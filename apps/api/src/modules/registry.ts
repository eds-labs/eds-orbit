import {
  validateRegistry,
  type ServerModule,
  type ValidatedRegistry,
} from "../../../../packages/module-contracts/src/index.ts";
import { platformDeclaration } from "../platform/modules/platform-declaration.ts";
import { knowledgeModule } from "./knowledge/manifest.ts";
import { marketingModule } from "./marketing/manifest.ts";

/**
 * The static module registry (ADR 0009, AD-01). The API and the worker are
 * the only importers; both validate it when they start.
 */
export const modules: readonly ServerModule[] = [
  knowledgeModule,
  marketingModule,
];

let validated: ValidatedRegistry | undefined;
/** The validated registry; throws MODULE_REGISTRY_INVALID on a broken manifest. */
export function moduleRegistry(): ValidatedRegistry {
  validated ??= validateRegistry(modules, platformDeclaration);
  return validated;
}
