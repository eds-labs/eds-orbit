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
import { authorize, PROJECT_OWN } from "../tenancy/permissions.ts";
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

/** Why an owner settles unclear reservations (WP2 C); no free text is stored. */
export const SETTLE_REASONS = [
  "provider_invoice_checked",
  "provider_dashboard_checked",
  "other",
] as const;
export const settleUnknownReservationsInput = z
  .object({
    reservationIds: z.array(z.uuid()).min(1).max(100),
    reason: z.enum(SETTLE_REASONS),
    /** The owner's own note; only its length is audited. Required for `other`. */
    note: z.string().trim().max(300).optional(),
    confirm: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    // "Other" says nothing by itself: the owner names what was checked.
    if (value.reason === "other" && !value.note)
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "SETTLE_NOTE_REQUIRED",
      });
  });

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
          registeredConnectionProviderIds().filter((id) => {
            const def = registeredConnectionProvider(id)!;
            return (
              providerScopes(def).includes("project") && !def.managedByModule
            );
          }) as [string, ...string[]],
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
  // Settles reservations whose outcome stayed unclear at their reserved
  // amount, the ceiling their month already counts (plan 2026-11-10 WP2 C).
  // The owner names each reservation, the reason (after checking the
  // provider's billing) and confirms; any month, this project only. Only
  // rows still `unknown` change, guarded in the update itself, and counters
  // move only for rows that changed, so a repeated or concurrent call never
  // moves them twice. A row in any other state refuses the whole request.
  // Audited content-free: ids, reason, count, amount, the note's length.
  "settle-unknown-reservations": sharedTransaction(async (tx, { scope, input }) => {
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
    // `confirm: true` is required by the schema; nothing settles without it.
    const { reservationIds, reason, note } =
      settleUnknownReservationsInput.parse(input);
    const ids = [...new Set(reservationIds)];
    const rows = await tx.budgetReservation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        id: { in: ids },
      },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length !== ids.length)
      throw new DomainError("RESERVATION_MISSING", 404);
    if (rows.some((row) => row.state !== "unknown"))
      throw new DomainError("RESERVATION_NOT_UNKNOWN", 409);
    let micros = 0n;
    const settled: string[] = [];
    for (const row of rows) {
      const changed = await tx.budgetReservation.updateMany({
        where: {
          id: row.id,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          state: "unknown",
        },
        data: { state: "settled", settledMicros: row.amountMicros },
      });
      if (changed.count !== 1) continue;
      await settleOnGrant(tx, row, row.amountMicros);
      await settleOnOrganization(tx, row, row.amountMicros);
      micros += row.amountMicros;
      settled.push(row.id);
    }
    if (settled.length)
      await audit(
        tx,
        scope,
        "budget.unknown_reservations_settled",
        scope.projectId,
        {
          count: settled.length,
          micros: micros.toString(),
          reservationIds: settled,
          reason,
          noteLength: note?.length ?? 0,
        },
      );
    return {
      settled: settled.length,
      micros: micros.toString(),
      reservationIds: settled,
    };
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
