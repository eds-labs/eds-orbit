import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { data, list } from "../shared.ts";
import { grantedConnections } from "../connections/central.ts";
import { CONNECTION_KIND, providerScopes } from "../connections/connections.ts";
import { driveIntegrationSource } from "../connections/google-drive.ts";
import {
  integrationState,
  type IntegrationCategory,
  type IntegrationState,
  type StateSource,
} from "../connections/integrations.ts";
import { telegramEnabled, telegramIntegrationSource } from "../connections/telegram.ts";
import { enabledModules } from "../modules/enforcement.ts";
import {
  ownerEnabled,
  registeredConnectionProvider,
  registeredProjectIntegrations,
} from "../modules/contributions.ts";
import { hiddenModules, moduleScope } from "../tenancy/module-roles.ts";
import { can, PROJECT_OWN } from "../tenancy/permissions.ts";
import { catalogCategories } from "./integration-catalog.ts";

// The project's integrations with a uniform state (ADR 0027). Any member may
// read the list, so it shows nothing beyond what the member's existing reads
// show: the project's connectors and granted connections (every member), the
// Drive status (every member), the Telegram bot (owners) and what each module
// contributes under its own permission check. Each item is built from
// explicit fields; no row is ever spread into the response.

export type ProjectIntegration = {
  id: string;
  provider: string;
  label: string;
  category: IntegrationCategory;
  scope: "central" | "project";
  state: IntegrationState;
  checkedAt: string | null;
  /** The mail server host of a mailbox (D-5 grouping); null otherwise. */
  group: string | null;
};

/** Internal: also what the organization usage needs. */
export type ProjectIntegrationRecord = ProjectIntegration & {
  connectionId: string | null;
  bound: boolean;
};

/** Called with the module id when a module's contribution throws. */
export type ContributionFailure = (moduleId: string, error: unknown) => void;

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * The project's integrations for the member, in the caller's project
 * transaction: central items first, then the project's, each in source
 * order. A module's contribution that throws adds nothing; `onFailure`
 * hears about it.
 */
export async function projectIntegrationRecords(
  tx: DbTx,
  scope: Scope,
  onFailure?: ContributionFailure,
): Promise<ProjectIntegrationRecord[]> {
  const enabled = await enabledModules(tx, scope);
  const hidden = hiddenModules(scope);
  const usable = (owner: string) => ownerEnabled(owner, enabled) && !hidden.includes(owner);
  const categories = catalogCategories();
  const category = (provider: string) => categories.get(provider) ?? "other";
  const providerLabel = (provider: string) =>
    registeredConnectionProvider(provider)?.label?.en ?? provider;
  /** The registered provider of a usable owner, else null (not listed). */
  const providerOf = (provider: unknown) => {
    const def = typeof provider === "string" ? registeredConnectionProvider(provider) : undefined;
    return def && usable(def.owner) ? def : null;
  };
  const record = (
    fields: Omit<ProjectIntegrationRecord, "category" | "group" | "connectionId" | "bound"> &
      Partial<Pick<ProjectIntegrationRecord, "group" | "connectionId" | "bound">>,
  ): ProjectIntegrationRecord => ({
    id: fields.id,
    provider: fields.provider,
    label: fields.label,
    category: category(fields.provider),
    scope: fields.scope,
    state: fields.state,
    checkedAt: fields.checkedAt,
    group: fields.group ?? null,
    connectionId: fields.connectionId ?? null,
    bound: fields.bound ?? false,
  });
  const out: ProjectIntegrationRecord[] = [];
  const rows = await list(tx, scope, CONNECTION_KIND);

  // Central connections granted to the project. Project-scope connections are
  // the ones a module manages itself (social accounts): their module lists them.
  const granted = await grantedConnections(tx, scope);
  const grantedIds = new Set(granted.map((g) => g.connection.id));
  for (const g of granted) {
    if (g.connection.scope === "project") continue;
    const def = providerOf(g.connection.provider);
    if (!def) continue;
    const row = rows.find((r) => data(r).centralConnectionId === g.connection.id);
    const binding: Extract<StateSource, { kind: "central" }>["binding"] = !providerScopes(def).includes("project")
      ? "not_needed"
      : row
        ? "present"
        : "missing";
    out.push(
      record({
        id: `connection:${g.connection.id}`,
        provider: g.connection.provider,
        label: g.connection.label,
        scope: "central",
        state: integrationState({
          kind: "central",
          status: g.connection.status,
          disabled: false,
          revoked: false,
          grant: "active",
          binding,
        }),
        checkedAt: row ? text(data(row).verifiedAt) : null,
        connectionId: g.connection.id,
        bound: binding !== "missing",
      }),
    );
  }

  // Bound connectors whose grant is gone (revoked, or the connection disabled).
  for (const row of rows) {
    const d = data(row);
    const central = text(d.centralConnectionId);
    if (!central || grantedIds.has(central) || !providerOf(d.provider)) continue;
    out.push(
      record({
        id: `connector:${row.id}`,
        provider: d.provider,
        label: providerLabel(d.provider),
        scope: "central",
        state: integrationState({
          kind: "central",
          status: String(d.status ?? ""),
          disabled: false,
          revoked: false,
          grant: "revoked",
          binding: "present",
        }),
        checkedAt: text(d.verifiedAt),
        connectionId: central,
        bound: true,
      }),
    );
  }

  // The project's own connectors (Postiz, Matomo, Slack, customer context,
  // mailboxes, issue sources).
  for (const row of rows) {
    const d = data(row);
    if (d.centralConnectionId || !providerOf(d.provider)) continue;
    out.push(
      record({
        id: `connector:${row.id}`,
        provider: d.provider,
        label: text(d.label) ?? text(d.name) ?? text(d.fromAddress) ?? providerLabel(d.provider),
        scope: "project",
        state: integrationState({ kind: "project_connector", status: text(d.status) }),
        checkedAt: text(d.verifiedAt) ?? text(d.checkedAt),
        group: d.provider === "email" ? text(d.smtpHost) : null,
      }),
    );
  }

  // Google Drive: the status route is open to every member.
  const drive = await driveIntegrationSource(tx, scope);
  if (drive.connected)
    out.push(
      record({
        id: "google_drive",
        provider: "google_drive",
        label: "Google Drive",
        scope: "project",
        state: integrationState(drive),
        checkedAt: null,
      }),
    );

  // The owner's Telegram bot: its status route is owner-only.
  if (can(scope, PROJECT_OWN) && telegramEnabled()) {
    const telegram = await telegramIntegrationSource(tx, scope);
    if (telegram.status !== "none")
      out.push(
        record({
          id: "telegram_owner_bot",
          provider: "telegram_owner_bot",
          label: "Telegram owner bot",
          scope: "project",
          state: integrationState({ kind: "telegram", status: telegram.status }),
          checkedAt: telegram.linkedAt,
        }),
      );
  }

  // Module contributions, each with the member's role in its module. One that
  // throws is left out: the list is an overview, and the module's own page
  // still shows the failure.
  for (const [moduleId, contribution] of registeredProjectIntegrations()) {
    if (!usable(moduleId)) continue;
    let items;
    try {
      items = await contribution(tx, moduleScope(scope, moduleId));
    } catch (error) {
      onFailure?.(moduleId, error);
      continue;
    }
    for (const item of items)
      out.push(
        record({
          id: item.id,
          provider: item.provider,
          label: item.label,
          scope: item.scope,
          state: item.state,
          checkedAt: item.checkedAt,
        }),
      );
  }

  // Central before project, source order within each.
  return [...out.filter((i) => i.scope === "central"), ...out.filter((i) => i.scope !== "central")];
}

/** What a member receives: the record without its internal fields. */
export function publicIntegration(record: ProjectIntegrationRecord): ProjectIntegration {
  return {
    id: record.id,
    provider: record.provider,
    label: record.label,
    category: record.category,
    scope: record.scope,
    state: record.state,
    checkedAt: record.checkedAt,
    group: record.group,
  };
}
