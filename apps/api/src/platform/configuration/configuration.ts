import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import {
  marketingProfile,
  visualIdentity,
  type Scope,
} from "../../../../../packages/schemas/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import { enabledModules } from "../modules/enforcement.ts";
import { registeredConfigurationSections } from "../modules/contributions.ts";
import { PROJECT_OWN, PROJECT_READ } from "../tenancy/permissions.ts";
import { approvedOperation, readOperation } from "../tasks/operation-tools.ts";
import type { ConfigurationSection } from "./types.ts";

// The project configuration as one document over MCP (plans/project-
// configuration-mcp.md): every enabled owner's sections, read with
// orbit:read, and partial changes an owner approves in Orbit before they
// are applied through each section's own save path. The configuration
// version is the sum of the section versions; every write raises it, so a
// proposal made against an older version is refused at proposal and again
// at approval.

export const projectConfigurationEnabled = () =>
  loadConfig().ORBIT_MCP_PROJECT_CONFIGURATION === "true";
/** Project administration over MCP (docs/MCP_PROJECT_ADMINISTRATION.md). */
export const projectAdministrationEnabled = () =>
  loadConfig().ORBIT_MCP_PROJECT_ADMINISTRATION === "true";

async function sections(tx: DbTx, scope: Scope) {
  return registeredConfigurationSections(await enabledModules(tx, scope));
}

/** Every enabled section's values, versions and field requirements. */
export async function readConfiguration(tx: DbTx, scope: Scope) {
  const out: Record<string, unknown> = {};
  let version = 0;
  for (const { id, section } of await sections(tx, scope)) {
    const read = await section.read(tx, scope);
    version += read.version;
    out[id] = {
      label: section.label,
      version: read.version,
      editable: Boolean(section.apply),
      values: read.values,
      fields: read.fields,
      ...(read.notes ? { notes: read.notes } : {}),
    };
  }
  return { projectId: scope.projectId, version, sections: out };
}

/**
 * The Creative Studio switch (CS-D6, R64), read per call: the brand kit keys
 * of the visual identity are offered over MCP only while it is on. Read from
 * the configuration here, as the platform does not import modules. Tool
 * definitions are also read where the configuration is incomplete (at
 * import, in unit tests): there the switch counts as off.
 */
function creativeStudioOn() {
  try {
    return loadConfig().ORBIT_CREATIVE_STUDIO === "true";
  } catch (error) {
    if (error instanceof z.ZodError) return false;
    throw error;
  }
}
// The Creative Studio's brand kit keys of the visual identity.
const BRAND_KIT_KEYS = [
  "logos",
  "productAssetIds",
  "imagery",
  "typography",
  "forbiddenDesigns",
] as const;

// The editable sections' fields, each optional: MCP clients need a fixed,
// strict schema. The Marketing profile's comes from the shared schema, so
// both stay the same; the section validates the merged whole. The creative
// settings hold maps (template choices, formats per channel) that a strict
// tool schema cannot express, and a change replaces a visual identity field
// as a whole, so they stay out of reach here: a partial change never
// touches them (Creative Studio brand kit, Review Focus 1). The other brand
// kit keys are offered only while the Creative Studio is on.
// A partial change must not carry defaults either: zod fills the default of a
// field inside `.partial()`, which would overwrite the stored colours, fonts
// and design rules with the defaults of the fields the client left out. A
// defaulted field becomes optional twice, so the tool's JSON schema stays
// the one `.partial()` gave.
const visualIdentityChanges = (creative: boolean) =>
  z
    .object(
      Object.fromEntries(
        Object.entries(
          visualIdentity.omit(
            Object.fromEntries(
              ["creative", ...(creative ? [] : BRAND_KIT_KEYS)].map((key) => [
                key,
                true,
              ]),
            ) as { creative: true },
          ).shape,
        ).map(([key, field]) => [
          key,
          (field instanceof z.ZodDefault
            ? (field.unwrap() as z.ZodType).optional()
            : (field as z.ZodType)
          ).optional(),
        ]),
      ) as z.ZodRawShape,
    )
    .strict();
const marketingChanges = (creative: boolean) =>
  z
    .object(
      Object.fromEntries(
        Object.entries(marketingProfile.shape).map(([key, field]) => [
          key,
          key === "visualIdentity"
            ? visualIdentityChanges(creative).optional()
            : (field as z.ZodType).optional(),
        ]),
      ) as z.ZodRawShape,
    )
    .strict();
const changeSchema = (creative: boolean) =>
  z
    .object({
      // The configuration version the change was made against.
      expectedVersion: z.number().int().min(0),
      // Per section, only the fields to change.
      changes: z
        .object({ marketing: marketingChanges(creative).optional() })
        .strict(),
    })
    .strict();
const plainChange = changeSchema(false);
const studioChange = changeSchema(true);
/** The schema of a configuration change under the current Creative Studio switch. */
export const configurationChange = () =>
  creativeStudioOn() ? studioChange : plainChange;
type Change = z.infer<typeof studioChange>;

async function editable(tx: DbTx, scope: Scope, change: Change) {
  const allChanges = change.changes as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const ids = Object.keys(allChanges).filter(
    (id) => Object.keys(allChanges[id] ?? {}).length,
  );
  if (!ids.length) throw new DomainError("CONFIGURATION_CHANGES_REQUIRED", 400);
  const all = await sections(tx, scope);
  const chosen: Array<[string, ConfigurationSection]> = [];
  for (const id of ids) {
    const found = all.find((s) => s.id === id);
    if (!found) throw new DomainError("CONFIGURATION_SECTION_NOT_FOUND", 404);
    if (!found.section.apply)
      throw new DomainError("CONFIGURATION_SECTION_NOT_EDITABLE", 409);
    chosen.push([id, found.section]);
  }
  return chosen;
}

const sectionChanges = (change: Change, id: string) =>
  (change.changes as Record<string, Record<string, unknown> | undefined>)[id] ??
  {};

/** Refuses a change made against another version or invalid for a section. */
export async function validateConfigurationChange(
  tx: DbTx,
  scope: Scope,
  change: Change,
) {
  const chosen = await editable(tx, scope, change);
  if ((await readConfiguration(tx, scope)).version !== change.expectedVersion)
    throw new DomainError("CONFIGURATION_VERSION_CONFLICT", 409);
  for (const [id, section] of chosen)
    await section.validate?.(tx, scope, sectionChanges(change, id));
}

export async function applyConfigurationChange(
  tx: DbTx,
  scope: Scope,
  change: Change,
) {
  await validateConfigurationChange(tx, scope, change);
  for (const [id, section] of await editable(tx, scope, change))
    await section.apply!(tx, scope, sectionChanges(change, id));
  return {
    version: (await readConfiguration(tx, scope)).version,
    sections: Object.keys(change.changes),
  };
}

const getTool = readOperation({
  name: "project_configuration_get",
  module: "platform",
  feature: "project_configuration",
  mcpProjectRequired: true,
  description:
    "Reads the project's editable configuration (project settings, Marketing profile: product, audience, positioning, strategies, voice, links and more) with its version and which fields are required, optional or not used. Never returns credentials.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readConfiguration(tx, scope),
});

const UPDATE_DESCRIPTION =
  "Proposes a partial change to the project configuration: changes = {marketing: {field: value}} with only the fields to change, against expectedVersion from project_configuration_get.";
const updateOperation = (creative: boolean) =>
  approvedOperation({
    riskClass: "G",
    name: "project_configuration_update",
    // For outside clients (ChatGPT over MCP); the assistant reads only.
    assistant: false,
    module: "platform",
    feature: "project_configuration",
    proposable: projectConfigurationEnabled,
    policyRequired: false,
    mcpProjectRequired: true,
    description: creative
      ? `${UPDATE_DESCRIPTION} visualIdentity.creative (templates, formats per channel, logo placement) is read-only over MCP: it is edited in Orbit's Brand settings. Owners only; executes after approval in Orbit.`
      : `${UPDATE_DESCRIPTION} Owners only; executes after approval in Orbit.`,
    input: creative ? studioChange : plainChange,
    permission: PROJECT_OWN,
    validate: (tx, scope, args) => validateConfigurationChange(tx, scope, args),
    run: (tx, scope, args) => applyConfigurationChange(tx, scope, args),
    executionResult: async (_tx, _scope, saved) => saved,
  });
const plainUpdate = updateOperation(false);
const studioUpdate = updateOperation(true);
const currentUpdate = () => (creativeStudioOn() ? studioUpdate : plainUpdate);

/**
 * An object whose every property is read from the variant `pick` returns at
 * that moment: the update tool and its approval action follow the Creative
 * Studio switch per call (CS-D6), as the assignment tools do.
 */
function perCall<T extends object>(variants: T[], pick: () => T): T {
  const out = {} as T;
  for (const key of new Set(variants.flatMap((v) => Object.keys(v))))
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => (pick() as Record<string, unknown>)[key],
    });
  return out;
}

/** The platform's configuration tools and their approval action type. */
export const configurationTools = [
  getTool,
  perCall([plainUpdate.tool, studioUpdate.tool], () => currentUpdate().tool),
];
export const configurationActionTypes = {
  [plainUpdate.actionType]: perCall(
    [plainUpdate.action, studioUpdate.action],
    () => currentUpdate().action,
  ),
};
