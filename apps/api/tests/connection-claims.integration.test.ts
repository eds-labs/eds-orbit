import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  claimExclusiveConfigValue,
  createProjectConnection,
  releaseExclusiveConfigValue,
  revokeProjectConnection,
} from "../src/platform/connections/project-secrets.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PROVIDER = "social.account.facebook";
const KEY = "assignedAdAccounts";

/**
 * Exclusive config claims: a value (an ad account) belongs to one project of
 * an organization at a time. Uses a module-managed provider so the test does
 * not depend on the Ads module.
 */
describe.skipIf(!enabled)("exclusive connection config claims", () => {
  const fixtures: Array<Awaited<ReturnType<typeof createSocialProject>>> = [];
  let a: Scope;
  let b: Scope;
  let c: Scope;
  let a2: Scope;

  async function connection(scope: Scope) {
    const { connectionId } = await createProjectConnection(scope, {
      moduleId: "social",
      provider: PROVIDER,
      label: "Synthetic claims",
      config: {},
      secret: "synthetic-secret",
      purposes: ["social.publish"],
    });
    return { moduleId: "social", connectionId };
  }
  const claim = (scope: Scope, c: { moduleId: string; connectionId: string }, value = "act_1", key = KEY) =>
    claimExclusiveConfigValue(scope, { ...c, key, value });
  const config = async (id: string) =>
    (await authDb.connection.findUniqueOrThrow({ where: { id } })).config as Record<string, unknown>;

  beforeAll(async () => {
    const one = await createSocialProject();
    const other = await createSocialProject();
    fixtures.push(one, other);
    a = one.owner;
    c = other.owner;
    // Two more projects of the first organization.
    const extra = async (name: string): Promise<Scope> => {
      const project = await authDb.project.create({ data: { workspaceId: a.workspaceId, name } });
      return { ...a, projectId: project.id };
    };
    b = await extra("Synthetic claims B");
    a2 = a;
  });

  afterAll(async () => {
    for (const f of fixtures) await f.cleanup();
    await closeDatabase();
  });

  it("claims a value once per organization", async () => {
    const [ca, cb, cc] = [await connection(a), await connection(b), await connection(c)];
    await claim(a, ca);
    await expect(claim(b, cb)).rejects.toMatchObject({ code: "CONNECTION_VALUE_CLAIMED", status: 409 });
    await claim(c, cc);
    expect((await config(ca.connectionId))[KEY]).toEqual(["act_1"]);
    expect((await authDb.connection.findUniqueOrThrow({ where: { id: ca.connectionId } })).version).toBe(2);
    const audit = await authDb.systemAuditEvent.findFirst({
      where: { targetId: ca.connectionId, action: "connection.config_claimed" },
    });
    expect(audit?.metadata).toEqual({ provider: PROVIDER, key: KEY });
  });

  it("is idempotent for the same connection", async () => {
    const ca = await connection(a);
    await claim(a, ca, "act_dup");
    await claim(a, ca, "act_dup");
    expect((await config(ca.connectionId))[KEY]).toEqual(["act_dup"]);
  });

  it("the same project may hold the value on two connections", async () => {
    const [one, two] = [await connection(a2), await connection(a2)];
    await claim(a2, one, "act_same");
    await expect(claim(a2, two, "act_same")).resolves.toBeUndefined();
  });

  it("a revoked connection does not block", async () => {
    const [ca, cb] = [await connection(a), await connection(b)];
    await claim(a, ca, "act_rev");
    await revokeProjectConnection(a, { ...ca, reason: "test" });
    await expect(claim(b, cb, "act_rev")).resolves.toBeUndefined();
  });

  it("concurrent claims: exactly one wins", async () => {
    const [ca, cb] = [await connection(a), await connection(b)];
    const results = await Promise.allSettled([claim(a, ca, "act_race"), claim(b, cb, "act_race")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "CONNECTION_VALUE_CLAIMED" });
  });

  it("release frees the value", async () => {
    const [ca, cb] = [await connection(a), await connection(b)];
    await claim(a, ca, "act_free");
    await releaseExclusiveConfigValue(a, { ...ca, key: KEY, value: "act_free" });
    expect((await config(ca.connectionId))[KEY]).toEqual([]);
    await expect(claim(b, cb, "act_free")).resolves.toBeUndefined();
    // Releasing an absent value is not an error.
    await expect(
      releaseExclusiveConfigValue(a, { ...ca, key: KEY, value: "act_absent" }),
    ).resolves.toBeUndefined();
  });

  it("refuses more than 500 entries", async () => {
    const ca = await connection(a);
    await authDb.connection.update({
      where: { id: ca.connectionId },
      data: { config: { [KEY]: Array.from({ length: 500 }, (_, i) => `act_full${i}`) } },
    });
    await expect(claim(a, ca, "act_over")).rejects.toMatchObject({ code: "CONNECTION_CLAIMS_FULL", status: 409 });
  });

  it("invalid key or value -> CONNECTION_CLAIM_INVALID", async () => {
    const ca = await connection(a);
    await expect(claim(a, ca, "act_1", "1bad")).rejects.toMatchObject({ code: "CONNECTION_CLAIM_INVALID", status: 400 });
    await expect(claim(a, ca, "has space")).rejects.toMatchObject({ code: "CONNECTION_CLAIM_INVALID", status: 400 });
    await expect(claim(a, ca, "x".repeat(101))).rejects.toMatchObject({ code: "CONNECTION_CLAIM_INVALID", status: 400 });
    await expect(
      releaseExclusiveConfigValue(a, { ...ca, key: "1bad", value: "act_1" }),
    ).rejects.toMatchObject({ code: "CONNECTION_CLAIM_INVALID" });
  });

  it("another module's connection -> PROVIDER_NOT_MANAGED", async () => {
    await expect(
      createProjectConnection(a, {
        moduleId: "ads",
        provider: PROVIDER,
        label: "x",
        config: {},
        secret: "s",
        purposes: [],
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_NOT_MANAGED" });
    const ca = await connection(a);
    await expect(claim(a, { moduleId: "ads", connectionId: ca.connectionId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
