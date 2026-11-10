import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { data, exception, list } from "../src/shared.ts";
import {
  publishingBackend,
  readMarketingSettings,
  saveMarketingSettings,
} from "../src/modules/marketing/publishing/backend.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Marketing's publishing backend (ADR 0020, S9): Postiz unless the owner
 * switches a project to Social, which needs the social module on there.
 */
describe.skipIf(!enabled)("marketing publishing backend", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject({ name: "Synthetic marketing backend", modules: ["marketing"] });
  });
  afterAll(async () => {
    await p?.cleanup();
    await closeDatabase();
  });

  it("is Postiz by default", async () => {
    expect(await p.run((tx) => publishingBackend(tx, p.owner))).toBe("postiz");
    expect(await p.run((tx) => readMarketingSettings(tx, p.owner))).toEqual({ settings: { publishingBackend: "postiz" }, version: expect.any(Number) });
  });

  it("switches to Social only where the social module is on, by the owner, versioned and audited", async () => {
    const current = await p.run((tx) => readMarketingSettings(tx, p.owner));
    await expect(
      p.run((tx) => saveMarketingSettings(tx, p.owner, { publishingBackend: "social" }, current.version)),
    ).rejects.toThrow("SOCIAL_DISABLED");
    await expect(
      p.run((tx) => saveMarketingSettings(tx, p.editor, { publishingBackend: "postiz" }, current.version)),
    ).rejects.toThrow("OWNER_REQUIRED");
    await p.run((tx) =>
      tx.projectModule.create({
        data: { workspaceId: p.owner.workspaceId, projectId: p.owner.projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: p.owner.userId },
      }),
    );
    const saved = await p.run((tx) => saveMarketingSettings(tx, p.owner, { publishingBackend: "social" }, current.version));
    expect(saved.settings.publishingBackend).toBe("social");
    expect(await p.run((tx) => publishingBackend(tx, p.owner))).toBe("social");
    await expect(
      p.run((tx) => saveMarketingSettings(tx, p.owner, { publishingBackend: "postiz" }, current.version)),
    ).rejects.toThrow("SETTINGS_VERSION_CONFLICT");
    const audits = await p.run((tx) => tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "marketing.publishing_backend_changed" } }));
    expect(audits.map((a) => a.metadata)).toEqual([{ from: "postiz", to: "social" }]);
    // While the social switch is off a project on Social publishes nothing through Postiz either.
    delete process.env.ORBIT_SOCIAL;
    try {
      expect(await p.run((tx) => publishingBackend(tx, p.owner))).toBe("social");
    } finally {
      process.env.ORBIT_SOCIAL = "true";
    }
  });

  it("closes only the Postiz queue notices on the switch to Social; a rollback reopens nothing (WP1)", async () => {
    const save = async (publishingBackend: string) => {
      const current = await p.run((tx) => readMarketingSettings(tx, p.owner));
      return p.run((tx) => saveMarketingSettings(tx, p.owner, { publishingBackend }, current.version));
    };
    const notices = () =>
      p.run(async (tx) => (await list(tx, p.owner, "exceptions")).map((e): Record<string, any> => ({ ...data(e), id: e.id })));
    const resolvedAudits = () =>
      p.run((tx) => tx.auditEvent.findMany({ where: { projectId: p.owner.projectId, action: "marketing.postiz_queue_notice_resolved" } }));
    // What a publish attempt would leave behind; none may happen here.
    const sent = () =>
      p.run(async (tx) => ({
        publications: await tx.entity.count({ where: { projectId: p.owner.projectId, kind: "publications" } }),
        socialPublications: await tx.socialPublication.count({ where: { projectId: p.owner.projectId } }),
        outbox: await tx.outbox.count({ where: { projectId: p.owner.projectId } }),
      }));
    const start = await sent();
    await save("postiz");
    // A queue notice the stopped watch left open, and a notice of another kind.
    const stalled = await p.run((tx) => exception(tx, p.owner, "POSTIZ_QUEUE_STALLED", randomUUID()));
    await p.run((tx) => exception(tx, p.owner, "POSTIZ_QUEUE_STALLED", randomUUID()));
    const remote = await p.run((tx) => exception(tx, p.owner, "REMOTE_POST_MISSING", randomUUID()));
    expect(await resolvedAudits()).toEqual([]);

    await save("social");
    const after = await notices();
    expect(after.find((e) => e.id === stalled.id)).toMatchObject({
      status: "resolved",
      resolvedBy: p.owner.userId,
      resolution: "publishing_backend_social",
      count: 2,
    });
    expect(after.find((e) => e.id === remote.id)).toMatchObject({ status: "open" });
    expect((await resolvedAudits()).map((a) => [a.resourceId, a.actorId, a.metadata])).toEqual([
      [stalled.id, p.owner.userId, { code: "POSTIZ_QUEUE_STALLED", count: 2, reason: "publishing_backend_social" }],
    ]);
    // Nothing deleted: the notice keeps its history.
    expect(await p.run((tx) => tx.entityVersion.count({ where: { entityId: stalled.id } }))).toBe(3);

    await save("postiz");
    const rolledBack = await notices();
    expect(rolledBack.find((e) => e.id === stalled.id)).toMatchObject({ status: "resolved" });
    expect(rolledBack.filter((e) => e.status === "open").map((e) => e.code)).toEqual(["REMOTE_POST_MISSING"]);
    expect(await resolvedAudits()).toHaveLength(1);
    expect(await sent()).toEqual(start);
  });
});
