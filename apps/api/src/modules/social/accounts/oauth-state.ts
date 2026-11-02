import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { openSecret, sealSecret } from "../../../platform/connections/secrets.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { DomainError } from "../../../shared.ts";
import { socialActive } from "../gate.ts";

// OAuth state (ADR 0020): "<projectId>.<32 random bytes>", single use, bound
// to the member who started it, valid ten minutes. Only its SHA-256 is
// stored; the PKCE verifier is sealed with the connection key ring.

const TTL_MS = 10 * 60_000;
const DAY = 24 * 60 * 60_000;
const uuid = z.uuid();

export type OAuthPlatform = "x" | "facebook";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new DomainError("SOCIAL_OAUTH_STATE_INVALID", 403);

/** The project a state belongs to (the uuid before the first dot). */
export function projectOfState(state: string): string {
  const parsed = uuid.safeParse(state.split(".")[0]);
  if (!parsed.success || state.length > 200) throw new DomainError("SOCIAL_OAUTH_STATE_INVALID", 400);
  return parsed.data;
}

/** Starts an authorization: returns the state and the PKCE pair. */
export async function beginOAuthState(
  tx: DbTx,
  scope: Scope,
  input: { platform: OAuthPlatform; appConnectionId: string; redirectAfter: string },
  now = new Date(),
): Promise<{ state: string; codeVerifier: string; codeChallenge: string }> {
  const home = `/p/${scope.projectId}/social`;
  if (input.redirectAfter !== home && !input.redirectAfter.startsWith(`${home}/`))
    throw new DomainError("SOCIAL_REDIRECT_INVALID", 400);
  const state = `${scope.projectId}.${randomBytes(32).toString("base64url")}`;
  const codeVerifier = randomBytes(32).toString("base64url");
  await tx.socialOAuthState.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      stateHash: sha256(state),
      platform: input.platform,
      appConnectionId: input.appConnectionId,
      userId: scope.userId,
      codeVerifierCiphertext: JSON.stringify(sealSecret(codeVerifier)),
      redirectAfter: input.redirectAfter,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    },
  });
  return {
    state,
    codeVerifier,
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
  };
}

/**
 * Uses a state once. Run it in its own transaction before any token
 * exchange: a failed exchange must not leave the state usable.
 */
export async function consumeOAuthState(
  tx: DbTx,
  scope: Scope,
  input: { state: string; platform: OAuthPlatform },
  now = new Date(),
): Promise<{
  id: string;
  codeVerifier: string;
  appConnectionId: string;
  redirectAfter: string;
  createdAt: Date;
  expiresAt: Date;
}> {
  const hash = sha256(input.state);
  const row = await tx.socialOAuthState.findUnique({ where: { stateHash: hash } });
  if (
    !row ||
    row.projectId !== scope.projectId ||
    row.workspaceId !== scope.workspaceId ||
    row.userId !== scope.userId ||
    row.platform !== input.platform ||
    row.usedAt ||
    row.expiresAt.getTime() <= now.getTime()
  )
    throw invalid();
  const claimed = await tx.socialOAuthState.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw invalid();
  return {
    id: row.id,
    codeVerifier: openSecret(JSON.parse(row.codeVerifierCiphertext)),
    appConnectionId: row.appConnectionId,
    redirectAfter: row.redirectAfter ?? `/p/${scope.projectId}/social/accounts`,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Hourly: removes states that expired more than a day ago. */
export const socialOAuthStateCleanup: PeriodicTask = {
  name: "social-oauth-state-cleanup",
  async nextDueAt(tx, scope) {
    if (!(await socialActive(tx, scope))) return null;
    const stale = await tx.socialOAuthState.findFirst({
      where: { projectId: scope.projectId, expiresAt: { lt: new Date(Date.now() - DAY) } },
      select: { id: true },
    });
    return stale ? new Date() : null;
  },
  async run(scope) {
    const removed = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.socialOAuthState.deleteMany({
        where: { projectId: scope.projectId, expiresAt: { lt: new Date(Date.now() - DAY) } },
      }),
    );
    return { status: `removed ${removed.count}` };
  },
};
