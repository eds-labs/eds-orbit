import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { DomainError } from "../../shared.ts";
import { SUPPORT_SETTINGS_MANAGE } from "./permissions.ts";
import {
  supportSettingsDefaults,
  supportSettingsSchema,
  type SupportSettings,
} from "./settings.ts";

export type TaxonomyKind = "category" | "tag";
export type TaxonomyAction = "create" | "update" | "delete";
export type TaxonomyArgs = {
  key: string;
  label?: string;
  color?: SupportSettings["tags"][number]["color"];
};
const fieldFor = (kind: TaxonomyKind) =>
  kind === "category" ? "categories" : "tags";
export const readTaxonomySettings = (tx: DbTx, scope: Scope) =>
  readModuleSettings(
    tx,
    scope,
    "support",
    supportSettingsSchema,
    supportSettingsDefaults,
  );

/** Inspect exactly one target; unrelated definitions/settings are not part of its approval. */
export async function inspectTaxonomyChange(
  tx: DbTx,
  scope: Scope,
  kind: TaxonomyKind,
  action: TaxonomyAction,
  args: TaxonomyArgs,
) {
  authorize(scope, SUPPORT_SETTINGS_MANAGE);
  const current = await readTaxonomySettings(tx, scope);
  const items = current.settings[fieldFor(kind)];
  const before = items.find((item) => item.key === args.key) ?? null;
  if (action === "create" && before)
    throw new DomainError("SUPPORT_DEFINITION_EXISTS", 409);
  if (action !== "create" && !before)
    throw new DomainError("SUPPORT_DEFINITION_NOT_FOUND", 404);
  if (action === "create" && items.length >= 50)
    throw new DomainError("SUPPORT_DEFINITION_LIMIT", 409);
  if (
    action === "update" &&
    args.label === undefined &&
    args.color === undefined
  )
    throw new DomainError("SUPPORT_DEFINITION_CHANGE_REQUIRED", 400);
  if (action === "delete") {
    const used = await tx.supportTicket.count({
      where: {
        projectId: scope.projectId,
        ...(kind === "category"
          ? { category: args.key }
          : { tags: { has: args.key } }),
      },
    });
    if (used)
      throw new DomainError(
        kind === "category" ? "CATEGORY_IN_USE" : "TAG_IN_USE",
        409,
      );
    if (
      kind === "category" &&
      (await tx.supportInbox.count({
        where: {
          projectId: scope.projectId,
          archivedAt: null,
          defaultCategory: args.key,
        },
      }))
    )
      throw new DomainError("CATEGORY_IN_USE_BY_INBOX", 409);
  }
  const after =
    action === "delete"
      ? null
      : {
          ...(before ?? {}),
          key: args.key,
          ...(args.label === undefined ? {} : { label: args.label }),
          ...(kind === "tag" && args.color !== undefined
            ? { color: args.color }
            : {}),
        };
  // Validate against the native schema before creating a proposal as well as at approval.
  const nextItems =
    action === "create"
      ? [...items, after]
      : action === "delete"
        ? items.filter((item) => item.key !== args.key)
        : items.map((item) => (item.key === args.key ? after : item));
  const settings = supportSettingsSchema.parse({
    ...current.settings,
    [fieldFor(kind)]: nextItems,
  });
  return {
    current,
    settings,
    taxonomy: { kind, action, key: args.key, before, after },
  };
}

/** Called only in the existing exact owner decision transaction. */
export async function applyTaxonomyChange(
  tx: DbTx,
  scope: Scope,
  kind: TaxonomyKind,
  action: TaxonomyAction,
  args: TaxonomyArgs,
) {
  const change = await inspectTaxonomyChange(tx, scope, kind, action, args);
  const saved = await writeModuleSettings(
    tx,
    scope,
    "support",
    supportSettingsSchema,
    change.settings,
    change.current.version,
  );
  return {
    kind,
    action,
    key: args.key,
    item: change.taxonomy.after,
    settingsVersion: saved.version,
  };
}
