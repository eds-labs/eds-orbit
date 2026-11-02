import { randomUUID } from "node:crypto";
import { scoped, type Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  createProjectConnection,
  revokeProjectConnection,
  withProjectSecret,
  type JsonConfig,
} from "../../../platform/connections/project-secrets.ts";
import { audit, DomainError } from "../../../shared.ts";

// Saving a connected account (ADR 0020): its tokens go into a sealed secret
// of its own project connection; a reconnect of the same platform account
// rotates that secret instead of creating a second account.

export type SocialPlatform = "x" | "facebook" | "instagram" | "telegram";

export type ConnectedAccount = {
  platform: SocialPlatform;
  externalId: string;
  handle: string;
  displayName: string;
  secret: string;
  config: JsonConfig;
  settings?: Record<string, unknown>;
};

export async function saveConnectedAccount(scope: Scope, input: ConnectedAccount): Promise<{ accountId: string }> {
  const existing = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.socialAccount.findUnique({
      where: {
        projectId_platform_externalId: {
          projectId: scope.projectId,
          platform: input.platform,
          externalId: input.externalId,
        },
      },
    }),
  );
  let connectionId = existing?.connectionId;
  let created = false;
  try {
    if (!connectionId) throw new DomainError("NOT_FOUND", 404);
    await withProjectSecret(scope, { moduleId: "social", connectionId }, async () => ({
      result: null,
      secret: input.secret,
      config: input.config,
    }));
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
    connectionId = (
      await createProjectConnection(scope, {
        moduleId: "social",
        provider: `social.account.${input.platform}`,
        label: `${input.platform} ${input.handle}`,
        config: input.config,
        secret: input.secret,
        purposes: ["social_publish"],
      })
    ).connectionId;
    created = true;
  }
  try {
    return await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const settings = {
        ...((existing?.settings as object) ?? {}),
        ...(input.settings ?? {}),
      } as Prisma.InputJsonObject;
      const account = existing
        ? await tx.socialAccount.update({
            where: { id: existing.id },
            data: {
              connectionId: connectionId!,
              handle: input.handle,
              displayName: input.displayName,
              status: "active",
              capability: "read_verified",
              disabledAt: null,
              settings,
              version: { increment: 1 },
            },
          })
        : await tx.socialAccount.create({
            data: {
              id: randomUUID(),
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              connectionId: connectionId!,
              platform: input.platform,
              externalId: input.externalId,
              handle: input.handle,
              displayName: input.displayName,
              capability: "read_verified",
              settings,
              createdBy: scope.userId,
            },
          });
      await audit(tx, scope, "social.account.connected", account.id, {
        platform: input.platform,
        reconnect: Boolean(existing),
      });
      return { accountId: account.id };
    });
  } catch (error) {
    // A new connection without its account would be an orphan: revoke it.
    if (created)
      await revokeProjectConnection(scope, { moduleId: "social", connectionId: connectionId!, reason: "account_not_saved" });
    throw error;
  }
}
