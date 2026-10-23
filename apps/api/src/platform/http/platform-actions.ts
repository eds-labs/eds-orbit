import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  encrypt,
  entity,
  list,
  publicEntity,
  update,
} from "../shared.ts";
import { budgetMonthStart } from "../ai/budget.ts";
import {
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../ai/openai-configuration.ts";
import { settleOnGrant } from "../ai/central-ai.ts";
import {
  CONNECTION_KIND,
  connectionAccess,
  cutoverEnabled,
  providerScopes,
} from "../connections/connections.ts";
import { grantedConnections } from "../connections/central.ts";
import {
  registeredConnectionProvider,
  registeredConnectionProviderIds,
} from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { pauseProject } from "../governance/pause.ts";
import { retention } from "../governance/retention.ts";
import { addProjectMember } from "../tenancy/project-members.ts";
import { connectEmail, disconnectEmail } from "../email/connection.ts";
import {
  connectCustomerContext,
  disconnectCustomerContext,
} from "../customer-context/connection.ts";
import {
  ownTransaction,
  sharedTransaction,
  type ActionHandler,
} from "./actions.ts";

/** The platform's project actions (WP2.1f), moved unchanged from server.ts. */
export const platformActions: Record<string, ActionHandler> = {
  "openai-configure": ownTransaction(({ scope, input }) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const result = await saveOpenAiConfiguration(tx, scope, input);
      await audit(
        tx,
        scope,
        "openai_configuration.update",
        "openai_configuration",
        {
          configured: result.configured,
          source: result.source,
          modelCount: result.verifiedModels.length,
        },
      );
      return result;
    }),
  ),
  // The provider fields of the same configuration (Anthropic key, default
  // provider, Anthropic tiers, model registry, provider budgets, fallback).
  "ai-provider-configure": ownTransaction(({ scope, input }) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const result = await saveAiProviderConfiguration(tx, scope, input);
      await audit(
        tx,
        scope,
        "openai_configuration.update",
        "openai_configuration",
        {
          configured: result.configured,
          source: result.source,
          modelCount: result.verifiedModels.length,
          defaultProvider: result.defaultProvider,
          anthropicKeyConfigured: result.providers.anthropic.keyConfigured,
          fallback: result.fallback.onProviderBudgetStop,
        },
      );
      return result;
    }),
  ),
  "add-member": ownTransaction(({ scope, input }) =>
    addProjectMember(scope, input),
  ),
  "project-settings": ownTransaction(async ({ scope, input }) => {
    const i = z
      .object({
        name: z.string().min(1).max(100),
        timezone: z.string(),
        language: z.enum(["en", "de"]),
      })
      .strict()
      .parse(input);
    new Intl.DateTimeFormat("en", { timeZone: i.timezone });
    return authDb.project.update({ where: { id: scope.projectId }, data: i });
  }),
  retention: sharedTransaction((tx, { scope, input }) =>
    retention(tx, scope, z.number().int().min(30).max(3650).parse(input.days)),
  ),
  pause: sharedTransaction((tx, { scope, input }) =>
    pauseProject(tx, scope, z.boolean().parse(input.paused)),
  ),
  // A new connection of a provider a module contributes (WP2.5c).
  connector: sharedTransaction(async (tx, { scope, input, config }) => {
    const c = z
      .object({
        provider: z.enum(
          registeredConnectionProviderIds().filter((id) =>
            providerScopes(registeredConnectionProvider(id)!).includes(
              "project",
            ),
          ) as [string, ...string[]],
        ),
        baseUrl: z.url().optional(),
        credential: z.string().min(10).max(1000),
        siteId: z.string().max(100).optional(),
        channelId: z.string().max(100).optional(),
      })
      .strict()
      .parse(input);
    if (c.baseUrl && new URL(c.baseUrl).protocol !== "https:")
      throw new DomainError("HTTPS_REQUIRED");
    const provider = registeredConnectionProvider(c.provider)!;
    await assertModuleEnabled(tx, scope, provider.owner);
    const { credential, ...fields } = c;
    const metadata = provider.normalize?.(fields) ?? fields;
    return publicEntity(
      await create(tx, scope, CONNECTION_KIND, {
        ...metadata,
        encryptedCredential: encrypt(credential, config.CREDENTIAL_KEY),
        status: "configured",
        capabilities: [],
      }),
    );
  }),
  // Binds a granted central connection to the project (ADR 0013, WP3.4):
  // a project connection without its own key, whose project settings
  // (channels, site, verification) stay here. Needs the provider's cutover.
  "connector-attach": sharedTransaction(async (tx, { scope, input }) => {
    const c = z
      .object({
        connectionId: z.uuid(),
        siteId: z.string().max(100).optional(),
        channelId: z.string().max(100).optional(),
      })
      .strict()
      .parse(input);
    const granted = (await grantedConnections(tx, scope)).find(
      (g) => g.connection.id === c.connectionId,
    );
    if (!granted) throw new DomainError("CONNECTION_NOT_GRANTED", 404);
    const providerId = granted.connection.provider;
    const provider = registeredConnectionProvider(providerId);
    if (!provider || !providerScopes(provider).includes("project"))
      throw new DomainError("PROVIDER_NOT_ATTACHABLE", 409);
    if (!cutoverEnabled(providerId))
      throw new DomainError("CUTOVER_NOT_ENABLED", 409);
    await assertModuleEnabled(tx, scope, provider.owner);
    const existing = (await list(tx, scope, CONNECTION_KIND)).find(
      (row) => data(row).centralConnectionId === c.connectionId,
    );
    if (existing) return publicEntity(existing);
    const row = await create(tx, scope, CONNECTION_KIND, {
      // The central connection's non-secret settings, then the project's.
      ...granted.connection.config,
      provider: providerId,
      ...(c.siteId ? { siteId: c.siteId } : {}),
      ...(c.channelId ? { channelId: c.channelId } : {}),
      centralConnectionId: c.connectionId,
      status: "configured",
      capabilities: [],
    });
    await audit(tx, scope, "connector.attached", row.id, {
      provider: providerId,
      connectionId: c.connectionId,
    });
    return publicEntity(row);
  }),
  // A mailbox of the project over SMTP and IMAP (WP4.7); checked
  // separately. A known address updates its mailbox, a new one adds one.
  "email-connect": sharedTransaction((tx, { scope, input }) =>
    connectEmail(tx, scope, input),
  ),
  // Removes a mailbox no live support inbox (or other module) still uses.
  "email-disconnect": sharedTransaction((tx, { scope, input }) =>
    disconnectEmail(tx, scope, input),
  ),
  // A customer context provider endpoint (ADR 0011); checked separately.
  "customer-context-connect": sharedTransaction((tx, { scope, input }) =>
    connectCustomerContext(tx, scope, input),
  ),
  // Removes one; inboxes bound to it then fail closed.
  "customer-context-disconnect": sharedTransaction((tx, { scope, input }) =>
    disconnectCustomerContext(tx, scope, input),
  ),
  // Checks a connection with its provider and records what it can do; the
  // provider call runs outside any transaction (WP2.5c).
  "connector-health": ownTransaction(async ({ scope, input }) => {
    const c = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
        const row = await entity(
          tx,
          scope,
          CONNECTION_KIND,
          schemas.id.parse(input.connectorId),
        );
        const provider = registeredConnectionProvider(
          String(data(row).provider),
        );
        if (provider) await assertModuleEnabled(tx, scope, provider.owner);
        // A project connection bound to a central one checks with its key.
        return { row, access: await connectionAccess(tx, scope, data(row)) };
      }),
      d = data(c.row);
    const credential = c.access.credential;
    const provider = registeredConnectionProvider(String(d.provider));
    if (!provider?.check)
      throw new DomainError(
        provider?.checkUnsupported ?? "CONNECTOR_CHECK_UNSUPPORTED",
      );
    const result = await provider.check(
      { ...d, ...(c.access.baseUrl ? { baseUrl: c.access.baseUrl } : {}) },
      credential,
      { connectionId: c.row.id },
    );
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const current = await entity(tx, scope, CONNECTION_KIND, c.row.id);
      if (current.version !== c.row.version)
        throw new DomainError("CONNECTOR_CHANGED");
      return publicEntity(
        await update(tx, scope, current, {
          ...d,
          ...result,
          verifiedAt: new Date().toISOString(),
        }),
      );
    });
  }),
  // Settles the budget month's reservations whose outcome stayed unclear at
  // their reserved amount, the ceiling the month already counts. The owner
  // confirms this after checking the provider's billing; the attention item
  // "AI cost unclear" then clears. Audited with the count and amount.
  "settle-unknown-reservations": sharedTransaction(async (tx, { scope }) => {
    const rows = await tx.budgetReservation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        state: "unknown",
        createdAt: { gte: budgetMonthStart(new Date()) },
      },
    });
    let micros = 0n;
    for (const row of rows) {
      await settleOnGrant(tx, row, row.amountMicros);
      await tx.budgetReservation.update({
        where: { id: row.id },
        data: { state: "settled", settledMicros: row.amountMicros },
      });
      micros += row.amountMicros;
    }
    if (rows.length)
      await audit(
        tx,
        scope,
        "budget.unknown_reservations_settled",
        scope.projectId,
        { count: rows.length, micros: micros.toString() },
      );
    return { settled: rows.length, micros: micros.toString() };
  }),
  "resolve-exception": sharedTransaction(async (tx, { scope, input }) => {
    const e = await entity(
      tx,
      scope,
      "exceptions",
      schemas.id.parse(input.exceptionId),
    );
    return update(tx, scope, e, {
      ...data(e),
      status: "resolved",
      resolvedBy: scope.userId,
    });
  }),
};
