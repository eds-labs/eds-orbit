import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
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
});
