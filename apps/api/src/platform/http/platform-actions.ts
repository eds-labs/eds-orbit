import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  encrypt,
  entity,
  publicEntity,
  update,
} from "../shared.ts";
import { budgetMonthStart } from "../ai/budget.ts";
import {
  saveAiConfiguration,
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../ai/openai-configuration.ts";
import { settleOnGrant } from "../ai/central-ai.ts";
import { settleOnOrganization } from "../ai/org-budget.ts";
import { saveSpendPolicy } from "../ai/spend-policy.ts";
import {
  CONNECTION_KIND,
  providerScopes,
} from "../connections/connections.ts";
import {
  attachGrantedConnection,
  checkProjectConnection,
} from "../connections/project-connections.ts";
import {
  registeredConnectionProvider,
  registeredConnectionProviderIds,
} from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { pauseProject } from "../governance/pause.ts";
import { retention } from "../governance/retention.ts";
import { addProjectMember } from "../tenancy/project-members.ts";
import { updateProjectSettings } from "../tenancy/project-settings.ts";
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
  // The one save path (phase 3.2): { models?, providers? }, one audit entry.
  "ai-configure": ownTransaction(({ scope, input }) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const { result, sections } = await saveAiConfiguration(tx, scope, input);
      await audit(
        tx,
        scope,
        "openai_configuration.update",
        "openai_configuration",
        {
          sections,
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
  // Aliases of one section each, kept for existing clients.
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
  // The project's AI spending authority (ADR 0015); audited in the service.
  "ai-spend-policy": ownTransaction(({ scope, input }) =>
    scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const row = await saveSpendPolicy(tx, scope, input);
      return { id: row.id, version: row.version, ...(data(row) as object) };
    }),
  ),
  "add-member": ownTransaction(({ scope, input }) =>
    addProjectMember(scope, input),
  ),
  "project-settings": ownTransaction(({ scope, input }) =>
    updateProjectSettings(scope, input),
  ),
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
  // Binds a granted central connection to the project (ADR 0014, WP3.4):
  // a project connection without its own key, whose project settings
  // (channels, site, verification) stay here. Needs the provider's cutover.
  "connector-attach": sharedTransaction(async (tx, { scope, input }) =>
    publicEntity(await attachGrantedConnection(tx, scope, input)),
  ),
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
  "connector-health": ownTransaction(async ({ scope, input }) =>
    publicEntity(await checkProjectConnection(scope, input.connectorId)),
  ),
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
      await settleOnOrganization(tx, row, row.amountMicros);
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
