import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { data } from "../src/shared.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { requestWriteVerification } from "../src/modules/social/accounts/verify-write.ts";
import { resolvePublication } from "../src/modules/social/dispatch/control.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { DISPATCH } from "../src/modules/social/dispatch/jobs.ts";
import { reconcilePublication } from "../src/modules/social/dispatch/reconcile.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * A write verification whose send was unclear (P3): when Social reads the
 * test post back, or the owner says it was published, the account is
 * write-verified just as after a clear send; "not published" leaves it.
 */
describe.skipIf(!enabled)("write verification confirmed later", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let reply: (url: URL) => Response = () => new Response("{}", { status: 500 });
  const saved = { ...process.env };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const page = async () => {
    const pageId = String(Math.floor(Math.random() * 1e12));
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "facebook",
      externalId: pageId,
      handle: "Orbit Page",
      displayName: "Orbit Page",
      secret: JSON.stringify({ pageToken: "page-token" }),
      config: { metaUserId: "7", pageId, appConnectionId: randomUUID() },
    });
    await p.run((tx) => tx.socialAccount.update({ where: { id: accountId }, data: { capability: "read_verified" } }));
    return { accountId, pageId };
  };
  /** Approves the verification request and delivers its post: the publication. */
  const verify = async (accountId: string, text: string) => {
    const { requestId } = await p.run((tx) => requestWriteVerification(tx, p.owner, accountId, { version: 1, text }));
    const row = await p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id: requestId } }));
    await p.run((tx) => decideActionRequest(tx, p.owner, requestId, { version: row.version, packageHash: data(row).packageHash, decision: "approve" }));
    const job = (await p.run((tx) => tx.entity.findMany({ where: { projectId: p.owner.projectId, kind: "jobs" }, orderBy: { createdAt: "desc" } })))
      .map((j) => data(j))
      .find((j) => j.topic === DISPATCH)!;
    await dispatchPost({ ...p.owner, userId: "worker" }, String(job.resourceId), Number(job.postVersion));
    const variant = await p.run((tx) => tx.socialPostVariant.findFirstOrThrow({ where: { postId: String(job.resourceId) } }));
    const pub = await p.run((tx) => tx.socialPublication.findFirstOrThrow({ where: { variantId: variant.id } }));
    await deliverPublication({ ...p.owner, userId: "worker" }, pub.id);
    return p.run((tx) => tx.socialPublication.findUniqueOrThrow({ where: { id: pub.id } }));
  };
  const capability = async (id: string) => (await p.run((tx) => tx.socialAccount.findUniqueOrThrow({ where: { id } }))).capability;

  beforeAll(async () => {
    Object.assign(process.env, { ORBIT_SOCIAL: "true", EXECUTION_MODE: "live", ENABLE_EXTERNAL_WRITES: "true", ORBIT_SOCIAL_PLATFORMS: "facebook" });
    p = await createSocialProject({ name: "Synthetic verify read-back" });
    setSocialFetchForTests(async (url) => reply(new URL(String(url))));
  });
  afterEach(() => {
    reply = () => new Response("{}", { status: 500 });
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    for (const key of ["EXECUTION_MODE", "ENABLE_EXTERNAL_WRITES", "ORBIT_SOCIAL_PLATFORMS"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await p?.cleanup();
    await closeDatabase();
  });

  it("verifies the account when the unclear test post is read back", async () => {
    const { accountId, pageId } = await page();
    const text = `Orbit connection test ${randomUUID()}`;
    reply = () => {
      throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
    };
    const pub = await verify(accountId, text);
    expect(pub.status).toBe("outcome_unknown");
    expect(await capability(accountId)).toBe("read_verified");
    reply = () => json(200, { data: [{ id: `${pageId}_7`, message: text, created_time: new Date().toISOString().replace("Z", "+0000") }] });
    await reconcilePublication({ ...p.owner, userId: "worker" }, pub.id, "unknown");
    expect(await capability(accountId)).toBe("write_verified");
  });

  it("verifies the account when the owner says the test post was published, not when it was not", async () => {
    reply = () => {
      throw new ConnectorError("REQUEST_TIMEOUT", "unknown", true);
    };
    const yes = await page();
    const unclear = await verify(yes.accountId, `Orbit connection test ${randomUUID()}`);
    await p.run((tx) => resolvePublication(tx, p.owner, unclear.id, { resolution: "published_confirmed", version: unclear.version }));
    expect(await capability(yes.accountId)).toBe("write_verified");
    const no = await page();
    const missing = await verify(no.accountId, `Orbit connection test ${randomUUID()}`);
    await p.run((tx) => resolvePublication(tx, p.owner, missing.id, { resolution: "not_published", version: missing.version }));
    expect(await capability(no.accountId)).toBe("read_verified");
  });
});
