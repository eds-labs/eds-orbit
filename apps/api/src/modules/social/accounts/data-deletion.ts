import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authDb, scoped } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { projectConnectionsByConfig } from "../../../platform/connections/project-secrets.ts";
import { openSecret } from "../../../platform/connections/secrets.ts";
import { DomainError } from "../../../shared.ts";
import { disableAccount } from "./accounts.ts";
import { metaAppSecret, parseAppSecret } from "./apps.ts";

// Meta's data-deletion request (ADR 0020): Meta POSTs a `signed_request`
// (base64url HMAC-SHA256 signature, a dot, base64url JSON payload) signed
// with the app secret. Every account of that Meta user is disconnected, in
// every project; Meta gets a confirmation code and a status URL. Nothing of
// the payload is logged or audited except the code.
//
// The code proves itself: random bytes and the issue time, signed with a key
// derived from AUTH_SECRET. The deletion is done before the code is issued,
// so the public status page needs no stored request: a code it can verify
// is a completed request (a rotated AUTH_SECRET makes old codes unknown).

const MAX_AGE_S = 86_400;
const SKEW_S = 300;
const SYSTEM_ACTOR = "meta-data-deletion";
const CODE_RANDOM_BYTES = 9;
const CODE_BODY_BYTES = CODE_RANDOM_BYTES + 4;
const CODE_MAC_BYTES = 8;
const CODE = /^[a-f0-9]{42}$/;

const payload = z.object({
  algorithm: z.string(),
  issued_at: z.number().int(),
  user_id: z.string().min(1).max(100),
});
const invalid = () => new DomainError("SOCIAL_SIGNED_REQUEST_INVALID", 400);

function signedRequestOf(body: unknown): string {
  const raw =
    typeof body === "string"
      ? new URLSearchParams(body).get("signed_request")
      : typeof body === "object" && body !== null
        ? (body as { signed_request?: unknown }).signed_request
        : null;
  if (typeof raw !== "string" || raw.length > 8000) throw invalid();
  return raw;
}

/** The app secrets of every active Meta developer app (system connections). */
async function metaAppSecrets(): Promise<string[]> {
  const apps = await authDb.connection.findMany({
    where: { provider: "social.app.meta", revokedAt: null, disabledAt: null },
    select: { secrets: { where: { state: "active" } } },
  });
  return apps.flatMap((app) =>
    app.secrets.flatMap((secret) => {
      try {
        return [parseAppSecret(metaAppSecret, openSecret(secret)).appSecret];
      } catch {
        return [];
      }
    }),
  );
}

async function verify(signed: string): Promise<z.infer<typeof payload>> {
  const [sigPart, bodyPart, extra] = signed.split(".");
  if (!sigPart || !bodyPart || extra !== undefined) throw invalid();
  const signature = Buffer.from(sigPart, "base64url");
  const matches = (await metaAppSecrets()).some((secret) => {
    const expected = createHmac("sha256", secret).update(bodyPart).digest();
    return expected.length === signature.length && timingSafeEqual(expected, signature);
  });
  if (!matches) throw invalid();
  let parsed;
  try {
    parsed = payload.safeParse(JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8")));
  } catch {
    throw invalid();
  }
  if (!parsed.success || parsed.data.algorithm.toUpperCase() !== "HMAC-SHA256") throw invalid();
  const now = Math.floor(Date.now() / 1000);
  if (parsed.data.issued_at < now - MAX_AGE_S || parsed.data.issued_at > now + SKEW_S) throw invalid();
  return parsed.data;
}

const codeKey = () =>
  Buffer.from(hkdfSync("sha256", loadConfig().AUTH_SECRET, Buffer.alloc(0), "orbit-social-data-deletion-v1", 32));
const codeMac = (body: Buffer) => createHmac("sha256", codeKey()).update(body).digest().subarray(0, CODE_MAC_BYTES);

function confirmationCode(now = new Date()): string {
  const body = Buffer.alloc(CODE_BODY_BYTES);
  randomBytes(CODE_RANDOM_BYTES).copy(body);
  body.writeUInt32BE(Math.floor(now.getTime() / 1000), CODE_RANDOM_BYTES);
  return Buffer.concat([body, codeMac(body)]).toString("hex");
}

/** The status behind a confirmation code this Orbit issued; NOT_FOUND for any other. */
export function metaDataDeletionStatus(code: string): { status: "completed"; requestedAt: string } {
  if (!CODE.test(code)) throw new DomainError("NOT_FOUND", 404);
  const raw = Buffer.from(code, "hex");
  const body = raw.subarray(0, CODE_BODY_BYTES);
  if (!timingSafeEqual(raw.subarray(CODE_BODY_BYTES), codeMac(body))) throw new DomainError("NOT_FOUND", 404);
  return { status: "completed", requestedAt: new Date(body.readUInt32BE(CODE_RANDOM_BYTES) * 1000).toISOString() };
}

export async function handleMetaDataDeletion(body: unknown): Promise<{ url: string; confirmation_code: string }> {
  const request = await verify(signedRequestOf(body));
  const code = confirmationCode();
  for (const provider of ["social.account.facebook", "social.account.instagram"]) {
    for (const found of await projectConnectionsByConfig(provider, "metaUserId", request.user_id)) {
      const scope: Scope = {
        workspaceId: found.workspaceId,
        projectId: found.projectId,
        userId: SYSTEM_ACTOR,
        role: "owner",
      };
      const account = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        tx.socialAccount.findFirst({ where: { projectId: scope.projectId, connectionId: found.connectionId } }),
      );
      if (!account) continue;
      await disableAccount(scope, account, {
        reason: "meta_data_deletion",
        action: "social.meta.data_deletion",
        metadata: { platform: account.platform, confirmationCode: code },
      });
    }
  }
  return {
    url: `${new URL(loadConfig().APP_ORIGIN).origin}/data-deletion?code=${code}`,
    confirmation_code: code,
  };
}
