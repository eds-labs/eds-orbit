import { z } from "zod";
import { authDb, scoped } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import { normalizePostizBaseUrl } from "../../../../../packages/connectors/src/index.ts";
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
import { pauseProject } from "../governance/pause.ts";
import { retention } from "../governance/retention.ts";
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
  "add-member": ownTransaction(async ({ scope, input, auth }) => {
    const i = z
      .object({
        email: z.email(),
        name: z.string().min(1).max(100),
        password: z.string().min(12).max(128),
        role: z.enum(["owner", "editor", "viewer"]),
      })
      .strict()
      .parse(input);
    let user = await authDb.user.findUnique({ where: { email: i.email } });
    if (!user) {
      const result = await auth.api.signUpEmail({
        body: { email: i.email, name: i.name, password: i.password },
      });
      user = result.user as any;
    }
    const userId = user!.id;
    await authDb.$transaction(async (tx) => {
      await tx.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: scope.workspaceId, userId },
        },
        create: { workspaceId: scope.workspaceId, userId, role: "viewer" },
        update: {},
      });
      await tx.projectMember.upsert({
        where: { projectId_userId: { projectId: scope.projectId, userId } },
        create: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          userId,
          role: i.role,
        },
        update: { role: i.role },
      });
    });
    return { added: true };
  }),
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
  connector: sharedTransaction(async (tx, { scope, input, config }) => {
    const c = z
      .object({
        provider: z.enum(["postiz", "matomo", "slack"]),
        baseUrl: z.url().optional(),
        credential: z.string().min(10).max(1000),
        siteId: z.string().max(100).optional(),
        channelId: z.string().max(100).optional(),
      })
      .strict()
      .parse(input);
    if (c.baseUrl && new URL(c.baseUrl).protocol !== "https:")
      throw new DomainError("HTTPS_REQUIRED");
    const { credential, ...metadata } = c;
    if (metadata.provider === "postiz" && metadata.baseUrl)
      metadata.baseUrl = normalizePostizBaseUrl(metadata.baseUrl);
    return publicEntity(
      await create(tx, scope, "connectors", {
        ...metadata,
        encryptedCredential: encrypt(credential, config.CREDENTIAL_KEY),
        status: "configured",
        capabilities: [],
      }),
    );
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
