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
  publicEntity,
  update,
} from "../shared.ts";
import { saveOpenAiConfiguration } from "../ai/openai-configuration.ts";
import {
  CONNECTION_KIND,
  decryptCredential,
} from "../connections/connections.ts";
import {
  registeredConnectionProvider,
  registeredConnectionProviderIds,
} from "../modules/contributions.ts";
import { assertModuleEnabled } from "../modules/enforcement.ts";
import { pauseProject } from "../governance/pause.ts";
import { retention } from "../governance/retention.ts";
import { addProjectMember } from "../tenancy/project-members.ts";
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
  "add-member": ownTransaction(({ scope, input, auth }) =>
    addProjectMember(auth, scope, input),
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
          registeredConnectionProviderIds() as [string, ...string[]],
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
        return row;
      }),
      d = data(c);
    const credential = decryptCredential(d);
    const provider = registeredConnectionProvider(String(d.provider));
    if (!provider?.check)
      throw new DomainError(
        provider?.checkUnsupported ?? "CONNECTOR_CHECK_UNSUPPORTED",
      );
    const result = await provider.check(d, credential);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const current = await entity(tx, scope, CONNECTION_KIND, c.id);
      if (current.version !== c.version)
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
