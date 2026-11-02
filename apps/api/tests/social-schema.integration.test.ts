import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// The social module's tables (ADR 0020, plan §5): database rules the
// services will rely on.
describe.skipIf(!enabled)("social schema (ADR 0020)", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  const ids = (q = p) => ({
    id: randomUUID(),
    workspaceId: q.owner.workspaceId,
    projectId: q.owner.projectId,
  });
  const message = (work: Promise<unknown>) =>
    work.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const account = (tx: DbTx, q = p, data: Record<string, unknown> = {}) =>
    tx.socialAccount.create({
      data: {
        ...ids(q),
        connectionId: randomUUID(),
        platform: "telegram",
        externalId: randomUUID(),
        handle: "@orbit_test",
        displayName: "Orbit test channel",
        createdBy: q.owner.userId,
        ...data,
      },
    });
  const post = (tx: DbTx, q = p, data: Record<string, unknown> = {}) =>
    tx.socialPost.create({
      data: { ...ids(q), scheduleTimezone: "Europe/Berlin", createdBy: q.owner.userId, ...data },
    });
  const variant = (tx: DbTx, postId: string, accountId: string, q = p) =>
    tx.socialPostVariant.create({
      data: { ...ids(q), postId, accountId, body: "Hello", contentHash: "a".repeat(64) },
    });
  const publication = (tx: DbTx, variantId: string, accountId: string, data: Record<string, unknown> = {}) =>
    tx.socialPublication.create({
      data: { ...ids(), variantId, accountId, idempotencyKey: randomUUID(), ...data },
    });
  const chain = async (tx: DbTx) => {
    const a = await account(tx);
    const s = await post(tx);
    const v = await variant(tx, s.id, a.id);
    return { a, s, v };
  };

  beforeAll(async () => {
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("refuses two publications with the same idempotency key", async () => {
    const result = await message(
      p.run(async (tx) => {
        const { a, v } = await chain(tx);
        const key = randomUUID();
        await publication(tx, v.id, a.id, { idempotencyKey: key });
        return publication(tx, v.id, a.id, { idempotencyKey: key });
      }),
    );
    expect(result).toMatch(/idempotencyKey|Unique constraint/);
  });

  it("refuses a second mirror of the same legacy publication", async () => {
    const result = await message(
      p.run(async (tx) => {
        const { a, v } = await chain(tx);
        const legacy = randomUUID();
        await publication(tx, v.id, a.id, { legacyEntityId: legacy });
        return publication(tx, v.id, a.id, { legacyEntityId: legacy });
      }),
    );
    expect(result).toMatch(/SocialPublication_legacy_key|Unique constraint/);
  });

  it("refuses a second account for the same platform account", async () => {
    const result = await message(
      p.run(async (tx) => {
        const a = await account(tx);
        return account(tx, p, { externalId: a.externalId });
      }),
    );
    expect(result).toMatch(/Unique constraint|SocialAccount_external_key/);
  });

  it("refuses unknown platforms and publication states", async () => {
    const platform = await message(p.run((tx) => account(tx, p, { platform: "myspace" })));
    expect(platform).toMatch(/SocialAccount_platform_check/);
    const state = await message(
      p.run(async (tx) => {
        const { a, v } = await chain(tx);
        return publication(tx, v.id, a.id, { status: "maybe" });
      }),
    );
    expect(state).toMatch(/SocialPublication_status_check/);
  });

  it("refuses a scheduled post without a time", async () => {
    const result = await message(p.run((tx) => post(tx, p, { scheduleMode: "at" })));
    expect(result).toMatch(/SocialPost_schedule_check/);
  });

  it("refuses a writable legacy mirror", async () => {
    const result = await message(
      p.run((tx) => post(tx, p, { origin: "legacy_postiz", readOnly: false })),
    );
    expect(result).toMatch(/SocialPost_readonly_check/);
  });

  it("refuses a variant pointing to another project's account", async () => {
    const foreign = await other.run((tx) => account(tx, other));
    const result = await message(
      p.run(async (tx) => {
        const s = await post(tx);
        return variant(tx, s.id, foreign.id);
      }),
    );
    expect(result).toMatch(/SocialPostVariant_account_fkey|Foreign key constraint/);
  });

  it("hides another project's posts", async () => {
    const row = await p.run((tx) => post(tx));
    const seen = await other.run((tx) => tx.socialPost.findMany({ where: { id: row.id } }));
    expect(seen).toEqual([]);
  });

  it("keeps publications when the business role tries to delete one", async () => {
    const result = await message(
      p.run(async (tx) => {
        const { a, v } = await chain(tx);
        const row = await publication(tx, v.id, a.id);
        return tx.socialPublication.delete({ where: { id: row.id } });
      }),
    );
    expect(result).toMatch(/permission denied/);
  });

  it("drops a media reference when the platform purges its file", async () => {
    // deleteFile removes the stored object first and then the row
    // (platform/files/files.ts purge); the reference must not block that.
    const left = await p.run(async (tx) => {
      const { v } = await chain(tx);
      const file = await tx.file.create({
        data: {
          ...ids(),
          moduleId: "social",
          key: `social/${randomUUID()}`,
          mime: "image/png",
          size: 1,
          sha256: "f".repeat(64),
          encryption: "aes-256-gcm",
          createdBy: p.owner.userId,
          deletedAt: new Date(),
        },
      });
      await tx.socialPostMedia.create({
        data: { ...ids(), variantId: v.id, fileId: file.id, position: 0, kind: "image", sha256: "f".repeat(64) },
      });
      await tx.file.deleteMany({ where: { id: file.id, deletedAt: { not: null } } });
      return {
        files: await tx.file.count({ where: { id: file.id } }),
        media: await tx.socialPostMedia.count({ where: { variantId: v.id } }),
        variants: await tx.socialPostVariant.count({ where: { id: v.id } }),
      };
    });
    expect(left).toEqual({ files: 0, media: 0, variants: 1 });
  });

  it("deletes a post without publications together with its variants and media", async () => {
    const left = await p.run(async (tx) => {
      const { s, v } = await chain(tx);
      const file = await tx.file.create({
        data: {
          ...ids(),
          moduleId: "social",
          key: `social/${randomUUID()}`,
          mime: "image/png",
          size: 1,
          sha256: "b".repeat(64),
          encryption: "aes-256-gcm",
          createdBy: p.owner.userId,
        },
      });
      await tx.socialPostMedia.create({
        data: { ...ids(), variantId: v.id, fileId: file.id, position: 0, kind: "image", sha256: "b".repeat(64) },
      });
      await tx.socialPost.delete({ where: { id: s.id } });
      return {
        variants: await tx.socialPostVariant.count({ where: { postId: s.id } }),
        media: await tx.socialPostMedia.count({ where: { variantId: v.id } }),
      };
    });
    expect(left).toEqual({ variants: 0, media: 0 });
  });

  it("keeps a post and its variant once a publication exists", async () => {
    const { post: postDelete, variant: variantDelete } = await p.run(async (tx) => {
      const { a, s, v } = await chain(tx);
      await publication(tx, v.id, a.id);
      const tryDelete = async (name: string, work: () => Promise<unknown>) => {
        await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
        const result = await message(work());
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
        return result;
      };
      return {
        post: await tryDelete("post_delete", () => tx.socialPost.delete({ where: { id: s.id } })),
        variant: await tryDelete("variant_delete", () => tx.socialPostVariant.delete({ where: { id: v.id } })),
      };
    });
    expect(postDelete).toMatch(/SocialPublication_variant_fkey|Foreign key constraint/);
    expect(variantDelete).toMatch(/SocialPublication_variant_fkey|Foreign key constraint/);
  });

  it("refuses a publication for another account than its variant's", async () => {
    const result = await message(
      p.run(async (tx) => {
        const { v } = await chain(tx);
        const otherAccount = await account(tx);
        return publication(tx, v.id, otherAccount.id);
      }),
    );
    expect(result).toMatch(/SocialPublication_variant_fkey|Foreign key constraint/);
  });
});
