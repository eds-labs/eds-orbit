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
import {
  approvedOperation,
  readOperation,
} from "../tasks/operation-tools.ts";
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

// The editable sections' fields, each optional: MCP clients need a fixed,
// strict schema. The Marketing profile's comes from the shared schema, so
// both stay the same; the section validates the merged whole. The creative
// settings hold maps (template choices, formats per channel) that a strict
// tool schema cannot express, and a change replaces a visual identity field
// as a whole, so they stay out of reach here: a partial change never
// touches them (Creative Studio brand kit, Review Focus 1).
// A partial change must not carry defaults either: zod fills the default of a
// field inside `.partial()`, which would overwrite the stored colours, fonts
// and design rules with the defaults of the fields the client left out.
const visualIdentityChanges = z
  .object(
    Object.fromEntries(
      Object.entries(visualIdentity.omit({ creative: true }).shape).map(
        ([key, field]) => [
          key,
          (field instanceof z.ZodDefault ? field.unwrap() : field).optional(),
        ],
      ),
    ) as z.ZodRawShape,
  )
  .strict();
const marketingChanges = z
  .object(
    Object.fromEntries(
      Object.entries(marketingProfile.shape).map(([key, field]) => [
        key,
        key === "visualIdentity"
          ? visualIdentityChanges.optional()
          : (field as z.ZodType).optional(),
      ]),
    ) as z.ZodRawShape,
  )
  .strict();
export const configurationChange = z
  .object({
    // The configuration version the change was made against.
    expectedVersion: z.number().int().min(0),
    // Per section, only the fields to change.
    changes: z.object({ marketing: marketingChanges.optional() }).strict(),
  })
  .strict();
type Change = z.infer<typeof configurationChange>;

async function editable(tx: DbTx, scope: Scope, change: Change) {
  const allChanges = change.changes as Record<string, Record<string, unknown> | undefined>;
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
  ((change.changes as Record<string, Record<string, unknown> | undefined>)[id] ?? {});

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

const update = approvedOperation({
  name: "project_configuration_update",
  // For outside clients (ChatGPT over MCP); the assistant reads only.
  assistant: false,
  module: "platform",
  feature: "project_configuration",
  proposable: projectConfigurationEnabled,
  policyRequired: false,
  mcpProjectRequired: true,
  description:
    "Proposes a partial change to the project configuration: changes = {marketing: {field: value}} with only the fields to change, against expectedVersion from project_configuration_get. visualIdentity.creative (templates, formats per channel, logo placement) is read-only over MCP: it is edited in Orbit's Brand settings. Owners only; executes after approval in Orbit.",
  input: configurationChange,
  permission: PROJECT_OWN,
  validate: (tx, scope, args) => validateConfigurationChange(tx, scope, args),
  run: (tx, scope, args) => applyConfigurationChange(tx, scope, args),
  executionResult: async (_tx, _scope, saved) => saved,
});

/** The platform's configuration tools and their approval action type. */
export const configurationTools = [getTool, update.tool];
export const configurationActionTypes = { [update.actionType]: update.action };
