import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { createActionRequest, type ActionDefinition } from "../../../platform/governance/action-requests.ts";
import { authorize, PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { audit, DomainError } from "../../../shared.ts";
import { startDelivery } from "../dispatch/dispatch.ts";
import { platformEnabled, sendMode } from "../dispatch/gates.ts";
import { createPost, packageOf } from "../posts/posts.ts";
import type { SocialPlatform } from "./store.ts";

// Write verification (ADR 0020 §6.2, S5): before an account posts live,
// the owner approves one real test post with a text they chose. The post
// goes out like any other, and once it is published live the account is
// write_verified. The approval is the per-account permission for live
// posts Mario asked for (W2, owner only, never a mandate).

export const VERIFY_WRITE_ACTION = "social.account.verify_write";

const payload = z
  .object({
    accountId: z.uuid(),
    accountVersion: z.int().min(1),
    platform: z.enum(["x", "facebook", "instagram", "telegram"]),
    handle: z.string(),
    text: z.string().min(1).max(280),
  })
  .strict();
type VerifyPayload = z.infer<typeof payload>;
const requestInput = z.object({ version: z.int().min(1), text: z.string().trim().min(1).max(280) }).strict();

async function checkAccount(tx: DbTx, scope: Scope, accountId: string, version: number) {
  if (sendMode() !== "live") throw new DomainError("SOCIAL_LIVE_WRITES_DISABLED", 409);
  const account = await tx.socialAccount.findFirst({ where: { id: accountId, projectId: scope.projectId } });
  if (!account) throw new DomainError("NOT_FOUND", 404);
  if (account.version !== version) throw new DomainError("SOCIAL_VERSION_CONFLICT", 409);
  if (account.status !== "active") throw new DomainError("SOCIAL_ACCOUNT_NOT_ACTIVE", 409);
  if (!platformEnabled(account.platform as SocialPlatform)) throw new DomainError("SOCIAL_PLATFORM_NOT_AVAILABLE", 409);
  return account;
}

export const verifyWriteAction: ActionDefinition<VerifyPayload> = {
  riskClass: "W2",
  approvalMode: "approval_required",
  deciderRole: "owner",
  policyRequired: false,
  ttlMs: 7 * 86_400_000,
  payload,
  costCeilingMicros: () => 0,
  summary: (p) => ({ operation: { kind: "social_verify_write", platform: p.platform, handle: p.handle, text: p.text } }),
  async revalidate(tx, scope, p) {
    await checkAccount(tx, scope, p.accountId, p.accountVersion);
  },
  /** Creates the approved test post (publish now) and sends it on its way. */
  async onApproved(tx, scope, request) {
    const p = payload.parse((request.data as { payload: unknown }).payload);
    await checkAccount(tx, scope, p.accountId, p.accountVersion);
    const post = await createPost(tx, scope, {
      title: "Write verification",
      baseText: p.text,
      baseMedia: [],
      variants: [{ accountId: p.accountId }],
    });
    await tx.socialPost.update({
      where: { id: post.id },
      data: { originModule: "social", originType: "write_verification", scheduleMode: "now" },
    });
    const { hash } = await packageOf(tx, scope, post.id);
    await tx.socialPost.update({
      where: { id: post.id },
      data: { status: "approved", packageHash: hash, approvedAt: new Date(), approvedBy: scope.userId, version: { increment: 1 } },
    });
    await audit(tx, scope, "social.account.write_verification_approved", p.accountId, { postId: post.id, requestId: request.id });
    await startDelivery(tx, scope, post.id);
  },
};

/** The owner asks to verify posting on an account with one test text. */
export async function requestWriteVerification(tx: DbTx, scope: Scope, accountId: string, raw: unknown): Promise<{ requestId: string }> {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = requestInput.parse(raw);
  const account = await checkAccount(tx, scope, accountId, input.version);
  const request = await createActionRequest(tx, scope, {
    actionType: VERIFY_WRITE_ACTION,
    payload: {
      accountId: account.id,
      accountVersion: account.version,
      platform: account.platform,
      handle: account.handle,
      text: input.text,
    },
    requestedBy: { kind: "user", userId: scope.userId },
  });
  await audit(tx, scope, "social.account.write_verification_requested", account.id, { requestId: request.id });
  return { requestId: request.id };
}

/** After a live publication of a verification post: the account may post live. */
export async function markWriteVerified(tx: DbTx, scope: Scope, accountId: string) {
  const changed = await tx.socialAccount.updateMany({
    where: { id: accountId, projectId: scope.projectId },
    data: { capability: "write_verified", writeVerifiedAt: new Date(), version: { increment: 1 } },
  });
  if (changed.count === 1) await audit(tx, scope, "social.account.write_verified", accountId, {});
}
