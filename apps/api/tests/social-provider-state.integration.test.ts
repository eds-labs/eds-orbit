import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { instagramWorkflowStore, providerStateStore } from "../src/modules/social/adapters/provider-state-store.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

/**
 * Durable provider state (ADR 0020, S5): multi-step platform flows such as
 * Instagram's containers survive a crash, with compare-and-set writes and
 * a lease so only one worker continues a flow.
 */
describe.skipIf(!enabled)("social provider state", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("writes only on the current revision", async () => {
    const store = providerStateStore(p.owner, "test");
    const key = randomUUID();
    await store.create(key, { step: 1 });
    await expect(store.create(key, { step: 1 })).rejects.toMatchObject({ code: "SOCIAL_PROVIDER_STATE_CONFLICT" });
    expect(await store.read(key)).toEqual({ revision: 0, body: { step: 1 } });
    expect(await store.update(key, 0, { step: 2, extra: "x" })).toBe(1);
    expect(await store.read(key)).toEqual({ revision: 1, body: { step: 2, extra: "x" } });
    await expect(store.update(key, 0, { step: 3 })).rejects.toMatchObject({ code: "SOCIAL_PROVIDER_STATE_CONFLICT" });
    expect(await store.read(randomUUID())).toBeNull();
  });

  it("lets one holder claim a record until its lease ends", async () => {
    const store = providerStateStore(p.owner, "test");
    const key = randomUUID();
    await store.create(key, {});
    const token = await store.claim(key, 60_000);
    expect(token).toEqual(expect.any(String));
    expect(await store.claim(key, 60_000)).toBeNull();
    await store.release(key, token!);
    const again = await store.claim(key, 60_000);
    expect(again).toEqual(expect.any(String));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 61_000));
      expect(await store.claim(key, 60_000)).toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
    expect(await store.claim(randomUUID(), 60_000)).toBeNull();
  });

  it("keeps each project's records to itself", async () => {
    const key = randomUUID();
    await providerStateStore(p.owner, "test").create(key, { secret: "no" });
    expect(await providerStateStore(other.owner, "test").read(key)).toBeNull();
  });

  it("stores an Instagram workflow per publication the way the SDK uses it", async () => {
    const publicationId = randomUUID();
    const store = instagramWorkflowStore(p.owner, publicationId);
    const created = await store.create({ backend: "orbit", accountId: "17841", childIds: [], caption: "Hi", stage: "children" });
    expect(created).toMatchObject({ id: `pub_${publicationId}`, stage: "children" });
    expect(await store.update(created.id, { childIds: ["c1"], stage: "unknown" })).toMatchObject({ childIds: ["c1"], stage: "unknown", caption: "Hi" });
    expect(await store.get(created.id)).toMatchObject({ childIds: ["c1"], stage: "unknown" });
    expect(await store.claim(created.id)).toBe(true);
    expect(await store.claim(created.id)).toBe(false);
    await store.release!(created.id);
    expect(await store.claim(created.id)).toBe(true);
    expect(await store.get("igwf_other")).toBeUndefined();
    await expect(store.update("igwf_other", { stage: "published" })).rejects.toThrow();
  });
});
