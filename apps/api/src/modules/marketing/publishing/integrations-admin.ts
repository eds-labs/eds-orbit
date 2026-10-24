import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { ConnectorError } from "../../../../../../packages/connectors/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import { audit, data, DomainError, entity, list, update } from "../../../shared.ts";
import { defineTool } from "../../agents/tools/registry.ts";
import { userScoped } from "../../../platform/tenancy/scope.ts";
import { authorize, PROJECT_OWN, PROJECT_READ } from "../../../platform/tenancy/permissions.ts";
import { assertModuleEnabled } from "../../../platform/modules/enforcement.ts";
import { grantedConnections } from "../../../platform/connections/central.ts";
import {
  CONNECTION_KIND,
  connectionVerified,
  cutoverEnabled,
} from "../../../platform/connections/connections.ts";
import {
  attachGrantedConnection,
  checkProjectConnection,
} from "../../../platform/connections/project-connections.ts";
import {
  grantChannelsToProject,
  organizationActor,
  projectChannelOptions,
} from "../../../platform/connections/channel-assignment.ts";
import { testDriveConnection } from "../../../platform/connections/google-drive.ts";
import {
  assertSameChanges,
  requireChanges,
  settingChanges,
} from "../../../platform/configuration/changes.ts";
import { projectAdministrationEnabled } from "../../../platform/configuration/configuration.ts";
import {
  approvedOperation,
  readOperation,
} from "../../../platform/tasks/operation-tools.ts";
import { driveReconnectRequired } from "../brand/drive-readiness.ts";
import {
  assignedPostizChannels,
  assignPostizChannels,
} from "./postiz-assignment.ts";
import { POSTING_TIME } from "./posting-slots.ts";

// Postiz, Matomo and Google Drive over MCP (docs/MCP_PROJECT_ADMINISTRATION
// .md). Reads never return a credential. Changes are owner-approved and
// run through the same paths as Orbit's settings; verification runs the
// providers' read checks only and never publishes. Postiz write
// verification is a real test post and stays an explicit step in Orbit.

const CHANNEL_ID = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);

function postizView(row: { id: string; version: number; data: unknown }) {
  const d = data(row);
  const assigned = new Set(assignedPostizChannels(d).map((c: any) => c.id));
  const write = new Set<string>(d.writeVerifiedIntegrationIds ?? []);
  const media = new Set<string>(d.writeVerifiedMediaIntegrationIds ?? []);
  return {
    connectorId: row.id,
    version: row.version,
    status: d.status ?? null,
    centralConnectionId: d.centralConnectionId ?? null,
    baseUrl: d.baseUrl ?? null,
    verifiedAt: d.verifiedAt ?? null,
    channels: (Array.isArray(d.channels) ? d.channels : []).map((c: any) => ({
      id: c.id,
      name: c.name ?? null,
      platform: c.identifier ?? null,
      disabled: Boolean(c.disabled),
      assigned: assigned.has(c.id),
      writeVerified: write.has(c.id),
      mediaWriteVerified: media.has(c.id),
      postingTime: d.postingTimes?.[c.id] ?? null,
    })),
    writeVerifiedForThisInstance:
      Boolean(d.writeVerifiedInstanceId) &&
      d.writeVerifiedInstanceId === process.env.PUBLISHER_INSTANCE_ID,
  };
}

async function driveView(tx: DbTx, scope: Scope) {
  const connection = (await list(tx, scope, "drive_connection"))[0] ?? null;
  const storage = (await list(tx, scope, "drive_storage"))[0] ?? null;
  const config = loadConfig();
  return {
    clientConfigured: Boolean(
      config.GOOGLE_DRIVE_CLIENT_ID && config.GOOGLE_DRIVE_CLIENT_SECRET,
    ),
    connected: Boolean(connection && data(connection).encryptedRefreshToken),
    account: data(connection).account ?? null,
    reconnectRequired: driveReconnectRequired(connection),
    lastRefreshErrorCode: data(connection).lastRefreshErrorCode ?? null,
    rootFolderId: data(storage).rootFolderId ?? null,
    rootName: data(storage).rootName ?? null,
    enabled: data(storage).enabled === true,
    setup:
      "Connecting Google Drive needs the owner's Google consent in a browser: Orbit → Settings → Integrations → Google Drive. A folder named like the project becomes the root automatically.",
  };
}

export async function readIntegrations(tx: DbTx, scope: Scope) {
  const connectors = await list(tx, scope, CONNECTION_KIND);
  const of = (provider: string) =>
    connectors.filter((row) => data(row).provider === provider);
  const granted = await grantedConnections(tx, scope);
  const attached = new Set(
    connectors.map((row) => data(row).centralConnectionId).filter(Boolean),
  );
  return {
    projectId: scope.projectId,
    postiz: of("postiz").map(postizView),
    matomo: of("matomo").map((row) => ({
      connectorId: row.id,
      version: row.version,
      status: data(row).status ?? null,
      siteId: data(row).siteId ?? null,
      baseUrl: data(row).baseUrl ?? null,
      centralConnectionId: data(row).centralConnectionId ?? null,
      verifiedAt: data(row).verifiedAt ?? null,
    })),
    drive: await driveView(tx, scope),
    // Central connections granted to this project (ADR 0014).
    grantedConnections: granted
      .filter((g) => ["postiz", "matomo"].includes(g.connection.provider))
      .map((g) => ({
        connectionId: g.connection.id,
        provider: g.connection.provider,
        label: g.connection.label,
        scope: g.connection.scope,
        status: g.connection.status,
        attached: attached.has(g.connection.id),
        cutover: cutoverEnabled(g.connection.provider),
        channels: Array.isArray(g.grant.settings.channels)
          ? g.grant.settings.channels
          : [],
      })),
    // For organization owners and administrators: central connections whose
    // free channels can be given to this project.
    organizationChannels: await projectChannelOptions(scope),
    publishing: {
      executionMode: process.env.EXECUTION_MODE ?? null,
      externalWritesEnabled: process.env.ENABLE_EXTERNAL_WRITES === "true",
      postizDraftsEnabled: process.env.ENABLE_POSTIZ_DRAFTS === "true",
      publisherInstanceConfigured: Boolean(process.env.PUBLISHER_INSTANCE_ID),
    },
  };
}

const ACTIONS = [
  "postiz_assign_channels",
  "postiz_claim_channels",
  "attach_connection",
  "matomo_site",
] as const;
export const integrationChange = z
  .object({
    action: z.enum(ACTIONS),
    // postiz_assign_channels and matomo_site: the project connection.
    connectorId: z.uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
    // postiz_claim_channels and attach_connection: the central connection.
    connectionId: z.uuid().optional(),
    channelIds: z.array(CHANNEL_ID).max(20).optional(),
    // Fixed local daily posting times of assigned channels, e.g. "10:00".
    postingTimes: z
      .array(
        z
          .object({ channelId: CHANNEL_ID, time: z.string().regex(POSTING_TIME) })
          .strict(),
      )
      .max(20)
      .optional(),
    siteId: z.string().regex(/^\d{1,10}$/).optional(),
  })
  .strict();
type IntegrationChange = z.infer<typeof integrationChange>;
const timesOf = (change: IntegrationChange) =>
  change.postingTimes
    ? Object.fromEntries(change.postingTimes.map((t) => [t.channelId, t.time]))
    : undefined;

function need<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new DomainError(`FIELD_REQUIRED:${field}`, 400);
  return value;
}

async function connectorAt(
  tx: DbTx,
  scope: Scope,
  change: IntegrationChange,
  provider: string,
) {
  const row = await entity(tx, scope, CONNECTION_KIND, need(change.connectorId, "connectorId"));
  if (data(row).provider !== provider) throw new DomainError("CONNECTOR_PROVIDER_MISMATCH", 409);
  if (row.version !== need(change.expectedVersion, "expectedVersion"))
    throw new DomainError("CONNECTOR_VERSION_CONFLICT", 409);
  return row;
}

/** The exact change, checked like Orbit's settings would check it. */
async function proposedIntegration(tx: DbTx, scope: Scope, change: IntegrationChange) {
  switch (change.action) {
    case "postiz_assign_channels": {
      const row = await connectorAt(tx, scope, change, "postiz");
      const ids = [...need(change.channelIds, "channelIds")].sort();
      const d = data(row);
      if (!connectionVerified(d.status))
        throw new DomainError("POSTIZ_READ_VERIFICATION_REQUIRED", 409);
      // A bound connection uses the channels its organization assigned.
      if (d.centralConnectionId)
        throw new DomainError("USE_POSTIZ_CLAIM_CHANNELS", 409);
      const available = new Set(
        (d.channels ?? [])
          .filter((c: any) => c && !c.disabled)
          .map((c: any) => c.id),
      );
      if (new Set(ids).size !== ids.length || ids.some((id) => !available.has(id)))
        throw new DomainError("POSTIZ_ACCOUNT_UNAVAILABLE", 409);
      const before = {
        assignedIntegrationIds: [...(d.assignedIntegrationIds ?? [])].sort(),
        postingTimes: d.postingTimes ?? {},
        xLongPostIntegrationIds: [...(d.xLongPostIntegrationIds ?? [])].sort(),
      };
      const after = {
        assignedIntegrationIds: ids,
        postingTimes: timesOf(change) ?? before.postingTimes,
        // X long posts stay only for accounts that stay assigned.
        xLongPostIntegrationIds: before.xLongPostIntegrationIds.filter((id) =>
          ids.includes(id),
        ),
      };
      if (Object.keys(after.postingTimes).some((id) => !ids.includes(id)))
        throw new DomainError("POSTING_TIME_REQUIRES_ASSIGNED_ACCOUNT", 409);
      return settingChanges(before, after, `postiz.${row.id}.`);
    }
    case "postiz_claim_channels": {
      const actor = await organizationActor(scope.userId, scope.workspaceId);
      if (!actor) throw new DomainError("ORGANIZATION_OWNER_REQUIRED", 403);
      const connectionId = need(change.connectionId, "connectionId");
      const option = (await projectChannelOptions(scope)).find(
        (o) => o.connectionId === connectionId,
      );
      if (!option) throw new DomainError("CONNECTION_NOT_FOUND", 404);
      if (!option.cutover) throw new DomainError("CUTOVER_NOT_ENABLED", 409);
      const ids = need(change.channelIds, "channelIds");
      for (const id of ids) {
        const channel = option.channels.find((c) => c.id === id);
        if (!channel || channel.disabled) throw new DomainError("CHANNEL_UNKNOWN", 409);
        if (channel.holder === "other_project")
          throw new DomainError("CHANNEL_ASSIGNED_ELSEWHERE", 409);
      }
      const held = option.channels
        .filter((c) => c.holder === "this_project")
        .map((c) => c.id)
        .sort();
      return settingChanges(
        { channels: held },
        { channels: [...new Set([...held, ...ids])].sort() },
        `connection.${connectionId}.`,
      );
    }
    case "attach_connection": {
      const connectionId = need(change.connectionId, "connectionId");
      const granted = (await grantedConnections(tx, scope)).find(
        (g) => g.connection.id === connectionId,
      );
      if (!granted) throw new DomainError("CONNECTION_NOT_GRANTED", 404);
      if (!cutoverEnabled(granted.connection.provider))
        throw new DomainError("CUTOVER_NOT_ENABLED", 409);
      if (
        (await list(tx, scope, CONNECTION_KIND)).some(
          (row) => data(row).centralConnectionId === connectionId,
        )
      )
        throw new DomainError("CONNECTION_ALREADY_ATTACHED", 409);
      return settingChanges(
        {},
        {
          attach: {
            connectionId,
            provider: granted.connection.provider,
            ...(change.siteId ? { siteId: change.siteId } : {}),
          },
        },
      );
    }
    case "matomo_site": {
      const row = await connectorAt(tx, scope, change, "matomo");
      return settingChanges(
        { siteId: data(row).siteId ?? null },
        { siteId: need(change.siteId, "siteId") },
        `matomo.${row.id}.`,
      );
    }
  }
}

const proposed = async (tx: DbTx, scope: Scope, change: IntegrationChange) =>
  requireChanges(await proposedIntegration(tx, scope, change));

async function applyIntegration(tx: DbTx, scope: Scope, change: IntegrationChange) {
  switch (change.action) {
    case "postiz_assign_channels": {
      const row = await assignPostizChannels(tx, scope, {
        connectorId: change.connectorId!,
        version: change.expectedVersion!,
        integrationIds: change.channelIds!,
        ...(change.postingTimes ? { postingTimes: timesOf(change) } : {}),
      });
      return { connectorId: row.id, version: row.version };
    }
    case "postiz_claim_channels": {
      const actor = await organizationActor(scope.userId, scope.workspaceId);
      if (!actor) throw new DomainError("ORGANIZATION_OWNER_REQUIRED", 403);
      return grantChannelsToProject(tx, scope, actor, change.connectionId!, change.channelIds!);
    }
    case "attach_connection": {
      const row = await attachGrantedConnection(tx, scope, {
        connectionId: change.connectionId!,
        ...(change.siteId ? { siteId: change.siteId } : {}),
      });
      return { connectorId: row.id, version: row.version };
    }
    case "matomo_site": {
      const row = await entity(tx, scope, CONNECTION_KIND, change.connectorId!);
      // A new site needs a new read check.
      const saved = await update(tx, scope, row, {
        ...data(row),
        siteId: change.siteId,
        status: "configured",
      });
      await audit(tx, scope, "matomo.site_changed", row.id, { siteId: change.siteId });
      return { connectorId: saved.id, version: saved.version };
    }
  }
}

const getTool = readOperation({
  name: "integrations_get",
  module: "marketing",
  feature: "project_administration",
  mcpProjectRequired: true,
  description:
    "Reads the project's Postiz, Matomo and Google Drive integrations: status, channels and which are assigned or write-verified, Matomo site, Drive connection and root folder, granted central connections, and for organization owners the central Postiz channels that are free to assign. Never returns credentials.",
  input: z.object({}).strict(),
  permission: PROJECT_READ,
  run: (tx, scope) => readIntegrations(tx, scope),
});

const configure = approvedOperation({
  name: "integrations_configure",
  module: "marketing",
  feature: "project_administration",
  proposable: projectAdministrationEnabled,
  policyRequired: false,
  mcpProjectRequired: true,
  description:
    "Proposes an integration change. action: postiz_assign_channels (connectorId, expectedVersion, channelIds, optional postingTimes) sets the project's Postiz channels; postiz_claim_channels (connectionId, channelIds) gives free channels of an organization Postiz connection to this project (organization owners); attach_connection (connectionId, optional siteId) binds a granted central connection; matomo_site (connectorId, expectedVersion, siteId). No credentials. Owners only.",
  input: integrationChange,
  permission: PROJECT_OWN,
  validate: async (tx, scope, args) => {
    await proposed(tx, scope, args);
  },
  approvalContext: async (tx, scope, args) => ({
    changes: await proposed(tx, scope, args),
  }),
  revalidateContext: async (tx, scope, args, saved) =>
    assertSameChanges(saved, await proposed(tx, scope, args)),
  run: (tx, scope, args) => applyIntegration(tx, scope, args),
  executionResult: async (_tx, _scope, saved) => saved,
});

/** A failed provider check as a code and its likely cause. */
function failure(error: unknown) {
  const code =
    error instanceof DomainError || error instanceof ConnectorError
      ? error.code
      : "CHECK_FAILED";
  const status = error instanceof ConnectorError ? (error.status ?? null) : null;
  const cause =
    status === 401 || status === 403
      ? "The provider rejected the credential or its permissions."
      : status === 404
        ? "The provider endpoint or site was not found."
        : code === "CONNECTION_NOT_GRANTED"
          ? "The project holds no active grant or key for this connection."
          : code.startsWith("GOOGLE_DRIVE")
            ? "Google Drive is not connected or its consent was revoked."
            : "See the code; the check made no change.";
  return { ok: false as const, code, providerStatus: status, cause };
}

const verifyOutput = z
  .object({
    target: z.string(),
    ok: z.boolean(),
    status: z.string().nullable(),
    code: z.string().nullable(),
    cause: z.string().nullable(),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();

const verify = defineTool({
  name: "integration_verify",
  namespace: "marketing",
  description:
    "Runs a read-only check of one integration with its provider and records the verified state: postiz or matomo (connectorId from integrations_get), or drive. Publishes nothing. Reports Postiz write verification state, which needs a real test post approved in Orbit. Owners only.",
  parameters: z
    .object({
      target: z.enum(["postiz", "matomo", "drive"]),
      connectorId: z.string().nullable(),
    })
    .strict(),
  risk: "R0_read",
  permission: PROJECT_OWN,
  feature: "project_administration",
  deferLoading: true,
  exposure: { assistant: true, mcp: true },
  mcpProjectRequired: true,
  outputSchema: verifyOutput,
  async execute(ctx, raw) {
    const args = z
      .object({
        target: z.enum(["postiz", "matomo", "drive"]),
        connectorId: z.uuid().nullable().optional(),
      })
      .strict()
      .parse(raw);
    authorize(ctx.scope, PROJECT_OWN);
    await userScoped(ctx.scope, (tx) => assertModuleEnabled(tx, ctx.scope, "marketing"));
    let output: z.infer<typeof verifyOutput>;
    try {
      if (args.target === "drive") {
        const result = await testDriveConnection(ctx.scope);
        output = {
          target: "drive",
          ok: result.rootAccessible,
          status: result.rootAccessible ? "read_verified" : "connected_without_root",
          code: result.rootAccessible ? null : "DRIVE_ROOT_REQUIRED",
          cause: result.rootAccessible
            ? null
            : "Choose and enable a root folder in Orbit → Settings → Integrations → Google Drive.",
          details: { account: result.account },
        };
      } else {
        if (!args.connectorId) throw new DomainError("FIELD_REQUIRED:connectorId", 400);
        const row = await userScoped(ctx.scope, (tx) =>
          entity(tx, ctx.scope, CONNECTION_KIND, args.connectorId!),
        );
        if (data(row).provider !== args.target)
          throw new DomainError("CONNECTOR_PROVIDER_MISMATCH", 409);
        const checked = await checkProjectConnection(ctx.scope, row.id);
        const view = args.target === "postiz" ? postizView(checked) : null;
        const missingWrite = view
          ? view.channels.filter((c) => c.assigned && !c.writeVerified).map((c) => c.id)
          : [];
        output = {
          target: args.target,
          ok: true,
          status: data(checked).status ?? null,
          code: missingWrite.length ? "CHANNEL_WRITE_VERIFICATION_REQUIRED" : null,
          cause: missingWrite.length
            ? "Read access is verified. Publishing needs a write verification per channel: a real test post on a sandbox account, prepared and approved in Orbit (Marketing → Connections → Postiz). It is never run over MCP."
            : null,
          details: view
            ? {
                connectorId: view.connectorId,
                channels: view.channels,
                writeVerificationMissing: missingWrite,
                writeVerifiedForThisInstance: view.writeVerifiedForThisInstance,
              }
            : { connectorId: checked.id, siteId: data(checked).siteId ?? null },
        };
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      const f = failure(error);
      output = {
        target: args.target,
        ok: false,
        status: null,
        code: f.code,
        cause: f.cause,
        details: { providerStatus: f.providerStatus },
      };
    }
    return {
      output,
      cards: [
        {
          kind: "status" as const,
          label: output.ok ? "Integration verified" : "Integration check failed",
          status: output.ok ? "completed" : "failed",
        },
      ],
    };
  },
});

export const integrationAdminTools = [getTool, configure.tool, verify];
export const integrationAdminActionTypes = {
  [configure.actionType]: configure.action,
};
