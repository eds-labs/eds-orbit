import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { calendarItems } from "../src/modules/social/calendar/calendar.ts";
import { createPost, listPosts } from "../src/modules/social/posts/posts.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * The project calendar (ADR 0020 §6.2, S6): the posts timed in a range of
 * at most 62 days, with their accounts, approval and publication summary,
 * filtered by account, platform, status and origin.
 */
describe.skipIf(!enabled)("social calendar", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  let x = "";
  let telegram = "";

  const account = (tx: DbTx, q: typeof p, platform: string) =>
    tx.socialAccount.create({
      data: {
        id: randomUUID(),
        workspaceId: q.owner.workspaceId,
        projectId: q.owner.projectId,
        connectionId: randomUUID(),
        platform,
        externalId: randomUUID(),
        handle: `@${platform}_orbit`,
        displayName: platform,
        capability: "write_verified",
        createdBy: q.owner.userId,
      },
    });
  /** A post timed at `at` (UTC) for the given accounts. */
  const timed = async (at: string | null, accounts: string[], data: Record<string, unknown> = {}) => {
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: `Post ${at}`, baseMedia: [], variants: accounts.map((accountId) => ({ accountId })) }));
    await p.run((tx) =>
      tx.socialPost.update({
        where: { id: post.id },
        data: at ? { scheduleMode: "at", scheduledAt: new Date(at), scheduleLocal: at.slice(0, 16), ...data } : data,
      }),
    );
    return post.id;
  };
  const range = { from: "2026-12-01T00:00:00Z", to: "2027-01-01T00:00:00Z" };

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
    x = (await p.run((tx) => account(tx, p, "x"))).id;
    telegram = (await p.run((tx) => account(tx, p, "telegram"))).id;
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("lists the posts timed in the range in time order, with accounts, approval and publications", async () => {
    const late = await timed("2026-12-20T09:00:00Z", [x, telegram], { status: "scheduled" });
    const early = await timed("2026-12-03T09:00:00Z", [telegram]);
    await timed("2027-01-05T09:00:00Z", [x]);
    await timed(null, [x]);
    await p.run(async (tx) => {
      const variants = await tx.socialPostVariant.findMany({ where: { postId: late } });
      for (const [i, v] of variants.entries())
        await tx.socialPublication.create({
          data: {
            id: randomUUID(),
            workspaceId: p.owner.workspaceId,
            projectId: p.owner.projectId,
            variantId: v.id,
            accountId: v.accountId,
            idempotencyKey: randomUUID(),
            status: i === 0 ? "published" : "outcome_unknown",
            providerState: { test: true },
          },
        });
    });
    const { items, truncated } = await p.run((tx) => calendarItems(tx, p.viewer, range));
    expect(truncated).toBe(false);
    expect(items.map((i) => i.id)).toEqual([early, late]);
    expect(items[1]).toMatchObject({
      projectId: p.owner.projectId,
      status: "scheduled",
      approvalState: "none",
      readOnly: false,
      origin: "manual",
      publications: { total: 2, published: 1, failed: 0, unknown: 1, test: true },
    });
    expect(items[1]!.accounts.map((a) => a.platform).sort()).toEqual(["telegram", "x"]);
    expect(items[0]!.publications).toEqual({ total: 0, published: 0, failed: 0, unknown: 0, test: false });
    // The list view shows the same markers.
    const listed = (await p.run((tx) => listPosts(tx, p.viewer, {}))).items.find((i) => i.id === late)!;
    expect(listed).toMatchObject({ origin: "manual", readOnly: false, publications: { total: 2, published: 1, unknown: 1, test: true } });
  });

  it("filters by platform, account, status and origin", async () => {
    const q = (extra: Record<string, string>) => p.run((tx) => calendarItems(tx, p.viewer, { ...range, ...extra }));
    const all = (await q({})).items;
    expect((await q({ platforms: "x" })).items.every((i) => i.accounts.some((a) => a.platform === "x"))).toBe(true);
    expect((await q({ platforms: "x" })).items.length).toBeLessThan(all.length);
    expect((await q({ accountIds: telegram })).items.length).toBe(all.filter((i) => i.accounts.some((a) => a.accountId === telegram)).length);
    expect((await q({ statuses: "scheduled" })).items.every((i) => i.status === "scheduled")).toBe(true);
    expect((await q({ origins: "marketing" })).items).toEqual([]);
    // The list view filters the same way.
    const listed = await p.run((tx) => listPosts(tx, p.viewer, { platforms: "x" }));
    expect(listed.items.every((i) => i.accounts.some((a) => a.platform === "x"))).toBe(true);
    expect(listed.items.length).toBeGreaterThan(0);
  });

  it("refuses a range over 62 days or one that ends before it starts", async () => {
    await expect(p.run((tx) => calendarItems(tx, p.viewer, { from: "2026-12-01T00:00:00Z", to: "2027-02-02T00:00:00Z" }))).rejects.toMatchObject({
      code: "SOCIAL_RANGE_TOO_LARGE",
      status: 422,
    });
    await expect(p.run((tx) => calendarItems(tx, p.viewer, { from: "2026-12-02T00:00:00Z", to: "2026-12-01T00:00:00Z" }))).rejects.toMatchObject({
      code: "SOCIAL_RANGE_INVALID",
      status: 422,
    });
  });

  it("caps a range at 500 posts and says so", async () => {
    const post = await p.run((tx) => createPost(tx, p.owner, { baseText: "Template", baseMedia: [], variants: [{ accountId: x }] }));
    const template = await p.run((tx) => tx.socialPost.findUniqueOrThrow({ where: { id: post.id } }));
    await p.run((tx) =>
      tx.socialPost.createMany({
        data: Array.from({ length: 501 }, (_, i) => ({
          id: randomUUID(),
          workspaceId: template.workspaceId,
          projectId: template.projectId,
          scheduleTimezone: "UTC",
          scheduleMode: "at",
          scheduledAt: new Date(Date.UTC(2027, 2, 1, 0, i)),
          createdBy: template.createdBy,
        })),
      }),
    );
    const { items, truncated } = await p.run((tx) =>
      calendarItems(tx, p.viewer, { from: "2027-03-01T00:00:00Z", to: "2027-03-02T00:00:00Z" }),
    );
    expect(items).toHaveLength(500);
    expect(truncated).toBe(true);
  });

  it("never shows another project's posts", async () => {
    const { items } = await other.run((tx) => calendarItems(tx, other.viewer, range));
    expect(items).toEqual([]);
  });
});
