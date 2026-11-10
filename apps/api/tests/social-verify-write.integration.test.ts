import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { registeredActionType } from "../src/platform/modules/contributions.ts";
import { data } from "../src/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { requestWriteVerification, VERIFY_WRITE_ACTION } from "../src/modules/social/accounts/verify-write.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { DISPATCH } from "../src/modules/social/dispatch/jobs.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const BOT = "222222222:AAsyntheticPublishingBotToken_0123456789";

/**
 * Write verification (ADR 0020 §6.2, S5): an owner asks to post one test
 * text to an account; the owner's approval of exactly that text is the
 * permission for a real post; once it is out, the account may post live.
 */
describe.skipIf(!enabled)("social write verification", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let worker: Scope;
  let status = 200;
  const saved = { ...process.env };
  const live = () => Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: "telegram" });
  const telegram = async () => {
    const chatId = `-100${Math.floor(Math.random() * 1e9)}`;
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "telegram",
      externalId: chatId,
      handle: "@orbit_news",
      displayName: "Orbit news",
      secret: JSON.stringify({ botToken: BOT }),
      config: { chatId, botId: "222222222", botUsername: "orbit_pub_bot" },
    });
    return accountId;
  };
  const accountRow = (id: string) => p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id } }));
  const approveAndSend = async (requestId: string) => {
    const row = await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } }));
    await p.run((tx) => decideActionRequest(tx, p.owner, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" }));
    const job = (await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "desc" } })))
      .map((j) => data(j))
      .find((j) => j.topic === DISPATCH)!;
    await dispatchPost(worker, String(job.resourceId), Number(job.postVersion));
    const variant = await p.run((tx) => tx.socialPostVariant.findFirstOrThrow({ where: { postId: String(job.resourceId) } }));
    const pub = await p.run((tx) => tx.socialPublication.findFirstOrThrow({ where: { variantId: variant.id } }));
    await deliverPublication(worker, pub.id);
    return { postId: String(job.resourceId), publicationId: pub.id };
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject();
    worker = { ...p.owner, userId: "worker" };
    setSocialFetchForTests(async () =>
      status === 200
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 5 } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error_code: status }), { status }),
    );
  });
  afterEach(() => {
    status = 200;
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await p?.cleanup();
    await closeDatabase();
  });

  it("is refused in test mode, where nothing could be verified", async () => {
    const id = await telegram();
    await expect(p.run((tx) => requestWriteVerification(tx, p.owner, id, { version: 1, text: "Orbit test" }))).rejects.toMatchObject({
      code: "SOCIAL_LIVE_WRITES_DISABLED",
      status: 409,
    });
  });

  it("posts the approved test text and marks the account verified", async () => {
    live();
    const id = await telegram();
    expect((await accountRow(id)).capability).toBe("read_verified");
    const { requestId } = await p.run((tx) => requestWriteVerification(tx, p.owner, id, { version: 1, text: "Orbit connection test" }));
    const request = data(await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } })));
    expect(request).toMatchObject({ actionType: VERIFY_WRITE_ACTION, status: "pending", payload: { accountId: id, text: "Orbit connection test" } });
    const { postId } = await approveAndSend(requestId);
    const post = await p.run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: postId } }));
    expect(post).toMatchObject({ originModule: "social", originType: "write_verification", status: "published" });
    const account = await accountRow(id);
    expect(account.capability).toBe("write_verified");
    expect(account.writeVerifiedAt).toBeInstanceOf(Date);
  });

  it("leaves the account unverified when the test post is refused", async () => {
    live();
    status = 403;
    const id = await telegram();
    const { requestId } = await p.run((tx) => requestWriteVerification(tx, p.owner, id, { version: 1, text: "Orbit connection test" }));
    const { publicationId } = await approveAndSend(requestId);
    expect((await accountRow(id)).capability).toBe("read_verified");
    expect((await p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id: publicationId } }))).status).toBe("blocked");
  });

  it("verifies Instagram with an image the platform accepts (final review I4)", async () => {
    Object.assign(process.env, { EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: "instagram" });
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "instagram",
      externalId: `1784${Math.floor(Math.random() * 1e6)}`,
      handle: "@orbit_ig",
      displayName: "Orbit IG",
      secret: JSON.stringify({ pageToken: "page-token" }),
      config: { pageId: "99", igUserId: "17841" },
    });
    await expect(
      p.run((tx) => requestWriteVerification(tx, p.owner, accountId, { version: 1, text: "Orbit connection test" })),
    ).rejects.toMatchObject({ code: "SOCIAL_MEDIA_REQUIRED", status: 422 });
    const png = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
    const image = (await uploadMedia(p.editor, { bytes: png, mime: "image/png" })).id;
    const { requestId } = await p.run((tx) =>
      requestWriteVerification(tx, p.owner, accountId, { version: 1, text: "Orbit connection test", mediaId: image }),
    );
    const request = data(await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } })));
    expect(request.payload).toMatchObject({ mediaId: image });
    const row = await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } }));
    await p.run((tx) => decideActionRequest(tx, p.owner, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" }));
    const post = await p.run((tx) => tx.socialPost.findFirstOrThrow({ where: { projectId: p.owner.projectId, originType: "write_verification", baseText: "Orbit connection test", baseMedia: { equals: [image] } } }));
    expect(post.status).toBe("approved");
  });

  it("is an owner's request, never an editor's, and never covered by a mandate", async () => {
    live();
    const id = await telegram();
    await expect(p.run((tx) => requestWriteVerification(tx, p.editor, id, { version: 1, text: "x" }))).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
    await expect(p.run((tx) => requestWriteVerification(tx, p.owner, id, { version: 9, text: "x" }))).rejects.toMatchObject({
      code: "SOCIAL_VERSION_CONFLICT",
    });
    await expect(p.run((tx) => requestWriteVerification(tx, p.owner, id, { version: 1, text: "x".repeat(281) }))).rejects.toBeDefined();
    const def = registeredActionType(VERIFY_WRITE_ACTION)!;
    expect(def).toMatchObject({ riskClass: "W2", deciderRole: "owner", policyRequired: false });
    expect(def.mandate).toBeUndefined();
    expect(def.mcpProposable).not.toBe(true);
  });
});
