import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { connectionSecret } from "../../../platform/connections/central.ts";
import { revokeProjectConnection } from "../../../platform/connections/project-secrets.ts";
import { audit, DomainError } from "../../../shared.ts";
import { appCredentials } from "./apps.ts";
import { socialFetch } from "./http.ts";

// The project's connected accounts (ADR 0020): a list without any secret,
// and disconnecting, which revokes the account's connection but keeps the
// account row for the history of its posts.

export const X_REVOKE = "https://api.x.com/2/oauth2/revoke";

type Settings = { lastCheckedAt?: string; lastCheckCode?: string | null; xLongPosts?: boolean };
type AccountRow = Awaited<ReturnType<DbTx["socialAccount"]["findFirstOrThrow"]>>;

const accountView = (row: AccountRow) => {
  const settings = row.settings as Settings;
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    displayName: row.displayName,
    status: row.status,
    capability: row.capability,
    connectedAt: row.createdAt.toISOString(),
    // Set when the account was disconnected; the row stays for its history.
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastCheckedAt: settings.lastCheckedAt ?? null,
    lastCheckCode: settings.lastCheckCode ?? null,
    // What posts may do on the account (S4): X Premium allows long posts.
    settings: { xLongPosts: settings.xLongPosts === true },
    version: row.version,
  };
};
export type SocialAccountView = ReturnType<typeof accountView>;

export async function listAccounts(tx: DbTx, scope: Scope) {
  const rows = await tx.socialAccount.findMany({
    where: { projectId: scope.projectId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { items: rows.map(accountView) };
}

const settingsInput = z
  .object({ version: z.int().min(1), settings: z.object({ xLongPosts: z.boolean().optional() }).strict() })
  .strict();

/** Changes what posts may do on the account; only X accounts know long posts. */
export async function updateAccountSettings(
  tx: DbTx,
  scope: Scope,
  accountId: string,
  raw: unknown,
): Promise<SocialAccountView> {
  const input = settingsInput.parse(raw);
  const row = await tx.socialAccount.findFirst({ where: { id: accountId, projectId: scope.projectId } });
  if (!row) throw new DomainError("NOT_FOUND", 404);
  const keys = Object.keys(input.settings);
  if (input.settings.xLongPosts !== undefined && row.platform !== "x")
    throw new DomainError("SOCIAL_SETTING_INVALID", 422);
  const changed = await tx.socialAccount.updateMany({
    where: { id: row.id, projectId: scope.projectId, version: input.version },
    data: { settings: { ...(row.settings as Settings), ...input.settings }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  await audit(tx, scope, "social.account.settings_changed", row.id, { keys });
  return accountView(await tx.socialAccount.findFirstOrThrow({ where: { id: row.id, projectId: scope.projectId } }));
}

/** Best effort: X forgets the token. A failure changes nothing. */
async function revokeAtX(scope: Scope, connectionId: string) {
  try {
    const { raw, app } = await scoped(scope.workspaceId, scope.projectId, async (tx) => ({
      raw: await connectionSecret(tx, connectionId),
      app: await appCredentials(tx, scope, "x"),
    }));
    const token = raw ? (JSON.parse(raw) as { accessToken?: string }).accessToken : undefined;
    if (!token) return false;
    const response = await socialFetch(X_REVOKE, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${app.x!.clientId}:${app.x!.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const disconnectInput = z.object({ version: z.int().min(1) }).strict();

export async function disconnectAccount(scope: Scope, accountId: string, raw: unknown) {
  const { version } = disconnectInput.parse(raw);
  const account = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const row = await tx.socialAccount.findFirst({ where: { id: accountId, projectId: scope.projectId } });
    if (!row) throw new DomainError("NOT_FOUND", 404);
    if (row.version !== version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
    return row;
  });
  if (account.status === "disabled") return { id: account.id, status: "disabled" };
  const providerRevoked = account.platform === "x" ? await revokeAtX(scope, account.connectionId) : false;
  await disableAccount(scope, account, {
    version,
    reason: "disconnect",
    action: "social.account.disconnected",
    metadata: { platform: account.platform, providerRevoked },
  });
  return { id: account.id, status: "disabled" };
}

/**
 * Revokes the account's connection and disables the account (the row and
 * its history stay). With `version`, a concurrent change is a conflict.
 */
export async function disableAccount(
  scope: Scope,
  account: { id: string; connectionId: string },
  input: { version?: number; reason: string; action: string; metadata: Record<string, string | boolean> },
) {
  try {
    await revokeProjectConnection(scope, { moduleId: "social", connectionId: account.connectionId, reason: input.reason });
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "NOT_FOUND") throw error;
  }
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const changed = await tx.socialAccount.updateMany({
      where: {
        id: account.id,
        projectId: scope.projectId,
        ...(input.version !== undefined ? { version: input.version } : {}),
      },
      data: { status: "disabled", disabledAt: new Date(), version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
    await audit(tx, scope, input.action, account.id, input.metadata);
  });
}
