import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { DomainError } from "../../../shared.ts";

// OAuth state (ADR 0025): "<projectId>.<32 random bytes>", single use, bound
// to the member who started it, valid ten minutes. Only its SHA-256 is
// stored. Meta's flow carries no PKCE verifier, so the column stays null.

const TTL_MS = 10 * 60_000;
const uuid = z.uuid();

export type AdsOAuthProvider = "meta";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new DomainError("ADS_OAUTH_STATE_INVALID", 403);

/** The project a state belongs to (the uuid before the first dot). */
export function projectOfAdsState(state: string): string {
  const parsed = uuid.safeParse(state.split(".")[0]);
  if (!parsed.success || state.length > 200) throw new DomainError("ADS_OAUTH_STATE_INVALID", 400);
  return parsed.data;
}

/** Starts an authorization: returns the state. */
export async function beginAdsOAuthState(
  tx: DbTx,
  scope: Scope,
  input: { provider: AdsOAuthProvider; appConnectionId: string; redirectAfter: string },
  now = new Date(),
): Promise<{ state: string }> {
  const home = `/p/${scope.projectId}/ads/accounts`;
  const after = input.redirectAfter;
  if (after !== home && !after.startsWith(`${home}?`) && !after.startsWith(`${home}/`))
    throw new DomainError("ADS_REDIRECT_INVALID", 400);
  const state = `${scope.projectId}.${randomBytes(32).toString("base64url")}`;
  await tx.adOAuthState.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      stateHash: sha256(state),
      provider: input.provider,
      appConnectionId: input.appConnectionId,
      userId: scope.userId,
      verifierCiphertext: null,
      redirectAfter: after,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    },
  });
  return { state };
}

export type ConsumedAdsState = {
  id: string;
  appConnectionId: string;
  redirectAfter: string;
  createdAt: Date;
  expiresAt: Date;
};

/**
 * Uses a state once. Run it in its own transaction before any token
 * exchange: a failed exchange must not leave the state usable.
 */
export async function consumeAdsOAuthState(
  tx: DbTx,
  scope: Scope,
  input: { state: string; provider: AdsOAuthProvider },
  now = new Date(),
): Promise<ConsumedAdsState> {
  const row = await tx.adOAuthState.findUnique({ where: { stateHash: sha256(input.state) } });
  if (
    !row ||
    row.projectId !== scope.projectId ||
    row.workspaceId !== scope.workspaceId ||
    row.userId !== scope.userId ||
    row.provider !== input.provider ||
    row.usedAt ||
    row.expiresAt.getTime() <= now.getTime()
  )
    throw invalid();
  const claimed = await tx.adOAuthState.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) throw invalid();
  return {
    id: row.id,
    appConnectionId: row.appConnectionId,
    redirectAfter: row.redirectAfter ?? `/p/${scope.projectId}/ads/accounts`,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
