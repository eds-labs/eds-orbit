import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { sealSecret } from "../../../platform/connections/secrets.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { DomainError } from "../../../platform/shared.ts";

const stateTtlMs = 10 * 60_000;
const uuid = z.uuid();
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

function hash(value: string, encoding: "hex" | "base64url") {
  return createHash("sha256").update(value).digest(encoding);
}
function invalidState() {
  return new DomainError("SEO_OAUTH_STATE_INVALID", 403);
}

/** Project hint only. Authority comes from the state row and the member session. */
export function googleSearchConsoleProjectOfState(state: string) {
  const [projectId, nonce, ...extra] = state.split(".");
  if (
    !uuid.safeParse(projectId).success ||
    !nonce ||
    !tokenPattern.test(nonce) ||
    extra.length
  )
    throw invalidState();
  return projectId!;
}

const project = ({ workspaceId, projectId }: Scope) => ({
  workspaceId,
  projectId,
});

export async function beginGoogleState(
  tx: DbTx,
  scope: Scope,
  appConnectionId: string,
  accountConnectionId?: string,
  now = new Date(),
) {
  const nonce = randomBytes(32).toString("base64url");
  const state = `${scope.projectId}.${nonce}`;
  const verifier = randomBytes(32).toString("base64url");
  const sealed = sealSecret(verifier);
  await tx.seoOAuthState.create({
    data: {
      ...project(scope),
      id: randomUUID(),
      appConnectionId,
      accountConnectionId,
      userId: scope.userId,
      stateHash: hash(state, "hex"),
      verifierCiphertext: sealed.ciphertext,
      verifierKeyId: sealed.keyId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + stateTtlMs),
    },
  });
  return { state, challenge: hash(verifier, "base64url") };
}

export type ConsumedGoogleSearchConsoleState = {
  workspaceId: string;
  projectId: string;
  userId: string;
  appConnectionId: string;
  accountConnectionId: string | null;
  verifier: { keyId: string; ciphertext: string };
};

/** Commit this transaction before the provider exchange so a failed exchange stays consumed. */
export async function consumeGoogleState(
  tx: DbTx,
  scope: Scope,
  state: string,
  now = new Date(),
): Promise<ConsumedGoogleSearchConsoleState> {
  if (googleSearchConsoleProjectOfState(state) !== scope.projectId)
    throw invalidState();
  const where = {
    ...project(scope),
    userId: scope.userId,
    stateHash: hash(state, "hex"),
    usedAt: null,
    expiresAt: { gt: now },
  };
  const row = await tx.seoOAuthState.findFirst({ where });
  if (!row) throw invalidState();
  const claimed = await tx.seoOAuthState.updateMany({
    where: { ...where, id: row.id },
    data: { usedAt: now, verifierCiphertext: "", verifierKeyId: "" },
  });
  if (claimed.count !== 1) throw invalidState();
  return {
    ...project(scope),
    userId: scope.userId,
    appConnectionId: row.appConnectionId,
    accountConnectionId: row.accountConnectionId,
    verifier: { keyId: row.verifierKeyId, ciphertext: row.verifierCiphertext },
  };
}

export const googleSearchConsoleOAuthStateCleanup: PeriodicTask = {
  name: "seo-oauth-state-cleanup",
  async nextDueAt(tx, scope) {
    const oldest = await tx.seoOAuthState.findFirst({
      where: project(scope),
      orderBy: { expiresAt: "asc" },
      select: { expiresAt: true },
    });
    return oldest?.expiresAt ?? null;
  },
  async run(scope) {
    await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.seoOAuthState.deleteMany({
        where: { ...project(scope), expiresAt: { lte: new Date() } },
      }),
    );
  },
};
