import { z } from "zod";
import { authDb, scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  createProjectConnection,
  withProjectSecret,
  type JsonConfig,
} from "../../../platform/connections/project-secrets.ts";
import { DomainError } from "../../../shared.ts";
import type { ProviderApp, ProviderGrant } from "../providers/types.ts";
import { adsAppCredentials } from "./app.ts";

// A project's Meta ad access (ADR 0025): the token lives in the sealed
// secret of a project connection of provider "ads.account.meta"; its config
// carries only non-secret facts. A reconnect of the same Meta user with the
// same developer app rotates that secret instead of adding a connection.

const MODULE = "ads";
const PROVIDER = "ads.account.meta";

export type GrantConfig = {
  metaUserId: string;
  appConnectionId: string;
  grantedScopes: string[];
  tokenType: "user" | "system_user";
  tokenExpiresAt: string | null;
  assignedAdAccounts: string[];
  expiryWarnedFor?: string | null;
};

const secretShape = z.object({ accessToken: z.string().min(1) }).passthrough();
const configShape = z.object({
  metaUserId: z.string().min(1),
  appConnectionId: z.string().min(1),
  grantedScopes: z.array(z.string()).default([]),
  tokenType: z.enum(["user", "system_user"]),
  tokenExpiresAt: z.string().nullable().default(null),
  assignedAdAccounts: z.array(z.string()).default([]),
  expiryWarnedFor: z.string().nullable().optional(),
});

/** Saves a grant: rotates the secret of the same Meta user's connection, else creates one. */
export async function saveGrant(
  scope: Scope,
  grant: ProviderGrant,
  appConnectionId: string,
): Promise<{ connectionId: string; reconnect: boolean }> {
  const secret = JSON.stringify({
    accessToken: grant.accessToken,
    tokenType: grant.tokenType,
    expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
  });
  const facts = {
    metaUserId: grant.userId,
    appConnectionId,
    grantedScopes: grant.grantedScopes,
    tokenType: grant.tokenType,
    tokenExpiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
    expiryWarnedFor: null,
  } satisfies JsonConfig;
  const existing = await authDb.connection.findFirst({
    where: {
      provider: PROVIDER,
      scope: "project",
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      revokedAt: null,
      AND: [
        { config: { path: ["metaUserId"], equals: grant.userId } },
        { config: { path: ["appConnectionId"], equals: appConnectionId } },
      ],
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (existing) {
    // assignedAdAccounts is not in `facts`: the merge keeps the claims.
    await withProjectSecret(scope, { moduleId: MODULE, connectionId: existing.id }, async () => ({
      result: null,
      secret,
      config: facts,
    }));
    return { connectionId: existing.id, reconnect: true };
  }
  const created = await createProjectConnection(scope, {
    moduleId: MODULE,
    provider: PROVIDER,
    label: `Meta: ${grant.userName ?? grant.userId}`.slice(0, 80),
    config: { ...facts, assignedAdAccounts: [] },
    secret,
    purposes: ["ads_manage"],
  });
  return { connectionId: created.connectionId, reconnect: false };
}

/** The connection's token, its config and the project's current developer app. */
export async function grantCredentials(
  scope: Scope,
  connectionId: string,
): Promise<{ accessToken: string; config: GrantConfig; app: ProviderApp & { connectionId: string } }> {
  let held: { accessToken: string; config: GrantConfig };
  try {
    held = await withProjectSecret(scope, { moduleId: MODULE, connectionId }, async ({ secret, config }) => {
      let accessToken: string;
      try {
        accessToken = secretShape.parse(JSON.parse(secret)).accessToken;
      } catch {
        throw new DomainError("ADS_ACCOUNT_RECONNECT_REQUIRED", 409);
      }
      const parsed = configShape.safeParse(config);
      if (!parsed.success) throw new DomainError("ADS_ACCOUNT_RECONNECT_REQUIRED", 409);
      return { result: { accessToken, config: parsed.data as GrantConfig } };
    });
  } catch (error) {
    // A revoked (or missing) connection holds no usable token.
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw new DomainError("ADS_ACCOUNT_RECONNECT_REQUIRED", 409);
    throw error;
  }
  const app = await scoped(scope.workspaceId, scope.projectId, (tx) => adsAppCredentials(tx, scope));
  if (app.connectionId !== held.config.appConnectionId) throw new DomainError("ADS_META_APP_CHANGED", 409);
  return {
    accessToken: held.accessToken,
    config: held.config,
    app: { connectionId: app.connectionId, clientId: app.clientId, clientSecret: app.clientSecret, configId: app.configId },
  };
}
