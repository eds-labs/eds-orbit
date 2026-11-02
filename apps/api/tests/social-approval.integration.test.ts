import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { registeredActionType } from "../src/platform/modules/contributions.ts";
import { data } from "../src/shared.ts";
import { uploadMedia } from "../src/modules/social/media/library.ts";
import { PUBLISH_NOW_ACTION, publishNow, reschedulePost, SCHEDULE_ACTION, schedulePost } from "../src/modules/social/posts/approval.ts";
import { createPost, getPost, updatePost } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));
const DAY = 86_400_000;

/**
 * Approving social posts (ADR 0020, S-D6, S-D9): a non-owner's schedule or
 * immediate publication becomes a request the owner decides; the owner's
 * own action is its approval; an approval binds content and time.
 */
describe.skipIf(!enabled)("social post approvals", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let x = "";
  let telegram = "";
  let image = "";

  const localIn = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 11) + "10:00";
  const account = (tx: DbTx, platform: string) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: p.owner.workspaceId,
        projectId: p.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_orbit`,
        displayName: `Orbit ${platform}`,
        capability: "write_verified",
        createdBy: p.owner.userId,
      },
    });
  const draft = (text = "We are live on X.") =>
    p.run((tx) =>
      createPost(tx, p.editor, {
        baseText: "We are live.",
        baseMedia: [image],
        variants: [{ accountId: telegram }, { accountId: x, text }],
      }),
    );
  const request = (id: string) => p.run((tx) => tx.entity.findUniqueOrThrow({ where: { id } }));
  const decide = async (who: Scope, id: string, decision: "approve" | "reject" = "approve") => {
    const row = await request(id);
    return p.run((tx) => decideActionRequest(tx, who, id, { version: row.version, packageHash: data(row).packageHash, decision }));
  };

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject();
    x = (await p.run((tx) => account(tx, "x"))).id;
    telegram = (await p.run((tx) => account(tx, "telegram"))).id;
    image = (await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" })).id;
  });
  afterAll(async () => {
    await p?.cleanup();
    await closeDatabase();
  });

  it("turns an editor's schedule into a request the owner decides", async () => {
    const post = await draft();
    const local = localIn(3);
    const waiting = await p.run((tx) => schedulePost(tx, p.editor, post.id, { version: 1, local, timeZone: "Europe/Berlin" }));
    expect(waiting).toMatchObject({ status: "needs_approval", approval: { state: "pending" }, schedule: { mode: "at", local } });
    const row = await request(waiting.approval.requestId!);
    const d = data(row);
    expect(d.actionType).toBe(SCHEDULE_ACTION);
    expect(d.payload).toMatchObject({
      postId: post.id,
      postVersion: waiting.version,
      packageHash: waiting.packageHash,
      requesterId: p.editor.userId,
      schedule: { mode: "at", local, timeZone: "Europe/Berlin" },
    });
    expect(d.payload.variants.map((v: { handle: string }) => v.handle).sort()).toEqual(["@telegram_orbit", "@x_orbit"]);
    await expect(decide(p.editor, row.id)).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
    await decide(p.owner, row.id);
    const approved = await p.run((tx) => getPost(tx, p.viewer, post.id));
    expect(approved).toMatchObject({ status: "scheduled", approval: { state: "approved", approvedBy: p.owner.userId } });
    expect(data(await request(row.id)).status).toBe("consumed");
  });

  it("keeps a post unchanged when an owner decides a request whose package no longer matches", async () => {
    const post = await draft();
    const waiting = await p.run((tx) => schedulePost(tx, p.editor, post.id, { version: 1, local: localIn(4) }));
    // A change that bypassed the service (the request stays pending).
    await p.run((tx) => tx.socialPostVariant.updateMany({ where: { postId: post.id, accountId: x }, data: { body: "Changed." } }));
    await p.run((tx) => tx.socialPost.update({ where: { id: post.id }, data: { packageHash: "e".repeat(64) } }));
    await expect(decide(p.owner, waiting.approval.requestId!)).rejects.toMatchObject({ code: "SOCIAL_APPROVAL_STALE", status: 409 });
    expect((await p.run((tx) => getPost(tx, p.viewer, post.id))).status).toBe("needs_approval");
  });

  it("withdraws the request when the post changes before the decision", async () => {
    const post = await draft();
    const waiting = await p.run((tx) => schedulePost(tx, p.editor, post.id, { version: 1, local: localIn(4) }));
    await p.run((tx) =>
      updatePost(tx, p.editor, post.id, {
        version: waiting.version,
        baseText: "We are live!",
        baseMedia: [image],
        variants: [{ accountId: telegram }, { accountId: x, text: "We are live on X." }],
      }),
    );
    await expect(decide(p.owner, waiting.approval.requestId!)).rejects.toMatchObject({ code: "ACTION_REQUEST_NOT_PENDING" });
  });

  it("lets an owner's own schedule be its approval", async () => {
    const post = await draft();
    const scheduled = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(5) }));
    expect(scheduled).toMatchObject({ status: "scheduled", approval: { state: "approved", requestId: null, approvedBy: p.owner.userId } });
    const audits = await p.run((tx) =>
      tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "social.post.approved", resourceId: post.id } }),
    );
    expect(audits.map((a) => a.metadata)).toEqual([{ channel: "owner_direct", packageHash: scheduled.packageHash }]);
  });

  it("refuses to schedule what a platform would refuse, naming the account", async () => {
    const post = await draft("x".repeat(281));
    const error = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(2) })).catch((e) => e);
    expect(error).toMatchObject({ code: "SOCIAL_VALIDATION_FAILED", status: 409 });
    expect(error.detail.variants).toEqual([{ accountId: x, issues: [{ code: "SOCIAL_TEXT_TOO_LONG", severity: "error", path: "body" }] }]);
    expect((await p.run((tx) => getPost(tx, p.viewer, post.id))).status).toBe("draft");
  });

  it("handles daylight-saving gaps and overlaps", async () => {
    const post = await draft();
    // Only times within a year can be scheduled; pick the next Berlin overlap or gap that lies ahead.
    const year = new Date().getUTCFullYear();
    const autumn = [year, year + 1].map((y) => `${y}-10-${lastSunday(y, 9)}T02:30`).find((l) => Date.parse(l + "Z") > Date.now() + DAY)!;
    const spring = [year, year + 1].map((y) => `${y}-03-${lastSunday(y, 2)}T02:30`).find((l) => Date.parse(l + "Z") > Date.now() + DAY)!;
    await expect(
      p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: spring, timeZone: "Europe/Berlin" })),
    ).rejects.toMatchObject({ code: "SOCIAL_SCHEDULE_TIME_GAP", detail: { suggestedLocal: spring.replace("02:30", "03:00") } });
    const scheduled = await p.run((tx) =>
      schedulePost(tx, p.owner, post.id, { version: 1, local: autumn, timeZone: "Europe/Berlin", fold: "earlier" }),
    );
    expect(scheduled.schedule).toMatchObject({ local: autumn, fold: "earlier", at: new Date(Date.parse(autumn + "Z") - 2 * 3_600_000).toISOString() });
  });

  it("returns an approved post to approval when an editor moves it, and asks an owner first", async () => {
    const post = await draft();
    const scheduled = await p.run((tx) => schedulePost(tx, p.owner, post.id, { version: 1, local: localIn(6) }));
    const moved = await p.run((tx) => reschedulePost(tx, p.editor, post.id, { version: scheduled.version, local: localIn(7) }));
    expect(moved).toMatchObject({ status: "needs_approval", approval: { state: "pending" }, schedule: { local: localIn(7) } });
    expect(moved.approval.approvedAt).toBeNull();
    await expect(
      p.run((tx) => reschedulePost(tx, p.owner, post.id, { version: moved.version, local: localIn(8) })),
    ).rejects.toMatchObject({ code: "SOCIAL_REAPPROVAL_REQUIRED", status: 409 });
    const again = await p.run((tx) => reschedulePost(tx, p.owner, post.id, { version: moved.version, local: localIn(8), reapprove: true }));
    expect(again).toMatchObject({ status: "scheduled", approval: { state: "approved", requestId: null } });
    expect(data(await request(moved.approval.requestId!)).status).toBe("canceled");
    // A draft only gets a new time.
    const other = await draft();
    const timed = await p.run((tx) => reschedulePost(tx, p.editor, other.id, { version: 1, local: localIn(9) }));
    expect(timed).toMatchObject({ status: "draft", schedule: { mode: "at", local: localIn(9) } });
  });

  it("turns an editor's publish-now into a request and approves it as publish-now", async () => {
    const post = await draft();
    const waiting = await p.run((tx) => publishNow(tx, p.editor, post.id, { version: 1 }));
    expect(data(await request(waiting.approval.requestId!)).actionType).toBe(PUBLISH_NOW_ACTION);
    await decide(p.owner, waiting.approval.requestId!);
    expect(await p.run((tx) => getPost(tx, p.viewer, post.id))).toMatchObject({ status: "approved", schedule: { mode: "now", at: null } });
  });

  it("refuses a decision once the scheduled time is too close", async () => {
    const post = await draft();
    const waiting = await p.run((tx) => schedulePost(tx, p.editor, post.id, { version: 1, local: localIn(2) }));
    // The owner decides one minute before the scheduled time.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.parse(waiting.schedule.at!) - 60_000));
      await expect(decide(p.owner, waiting.approval.requestId!)).rejects.toMatchObject({ code: "SOCIAL_SCHEDULE_TOO_SOON" });
    } finally {
      vi.useRealTimers();
    }
    expect((await p.run((tx) => getPost(tx, p.viewer, post.id))).status).toBe("needs_approval");
  });

  it("registers both types as owner-decided W2, never mandatable or MCP-proposable", () => {
    for (const type of [SCHEDULE_ACTION, PUBLISH_NOW_ACTION]) {
      const def = registeredActionType(type)!;
      expect(def).toMatchObject({ riskClass: "W2", deciderRole: "owner", policyRequired: false });
      expect(def.mandate).toBeUndefined();
      expect(def.mcpProposable).not.toBe(true);
    }
  });
});

/** Day of the last Sunday of a month (monthIndex 0-based). */
function lastSunday(year: number, monthIndex: number) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return String(last.getUTCDate() - last.getUTCDay()).padStart(2, "0");
}
