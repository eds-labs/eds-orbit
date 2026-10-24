import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  effectiveAiStatus,
  projectAiConfigurationView,
  runtimeOpenAiConfiguration,
  saveAiProviderConfiguration,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";
import { keyRuleReport } from "../src/platform/ai/key-rule-report.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * AI key rule v2 (plan decision E-1b, ORBIT_AI_KEY_RULE_V2): with it, an
 * environment key serves only a project without saved AI settings, for
 * every provider; a first save then needs a key the project keeps. The
 * dry-run report shows what a project would lose before the switch.
 */
describe.skipIf(!enabled)("AI key rule v2", () => {
  let scope: Scope;
  const users: string[] = [];
  const workspaces: string[] = [];
  const ENV_OPENAI = `sk-env-openai-${randomBytes(12).toString("hex")}`;
  const ENV_ANTHROPIC = `sk-ant-env-${randomBytes(12).toString("hex")}`;
  const OWN = `sk-own-openai-${randomBytes(12).toString("hex")}`;
  const saved = { ...process.env };
  const rate = {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 2_000_000,
    verifiedAt: new Date().toISOString(),
  };
  const models = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"];
  const openAiInput = {
    apiKey: OWN,
    verifiedModels: models,
    rateCard: Object.fromEntries(models.map((m) => [m, rate])),
  };
  const project = async (name: string) => {
    const row = await authDb.project.create({
      data: { workspaceId: scope.workspaceId, name },
    });
    return { ...scope, projectId: row.id };
  };
  const run = <T>(s: Scope, fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn);

  beforeAll(async () => {
    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        email: `${randomUUID()}@example.invalid`,
        name: "Synthetic key rule owner",
        emailVerified: true,
      },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic key rule",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    scope = {
      workspaceId: workspace.id,
      projectId: "",
      userId: user.id,
      role: "owner",
    };
    process.env.OPENAI_API_KEY = ENV_OPENAI;
    process.env.ANTHROPIC_API_KEY = ENV_ANTHROPIC;
  });
  afterEach(() => {
    delete process.env.ORBIT_AI_KEY_RULE_V2;
  });
  afterAll(async () => {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("keeps the environment for unsaved projects and ends it for every provider after a save", async () => {
    const fresh = await project("Unsaved");
    process.env.ORBIT_AI_KEY_RULE_V2 = "true";
    const unsaved = await run(fresh, (tx) => runtimeOpenAiConfiguration(tx, fresh));
    expect([unsaved.apiKey, unsaved.anthropicApiKey]).toEqual([ENV_OPENAI, ENV_ANTHROPIC]);

    const own = await project("Saved with an own OpenAI key");
    await run(own, (tx) => saveOpenAiConfiguration(tx, own, openAiInput));
    // Before v2 the environment Anthropic key still served the saved project.
    delete process.env.ORBIT_AI_KEY_RULE_V2;
    expect((await run(own, (tx) => runtimeOpenAiConfiguration(tx, own))).anthropicApiKey).toBe(
      ENV_ANTHROPIC,
    );
    process.env.ORBIT_AI_KEY_RULE_V2 = "true";
    const runtime = await run(own, (tx) => runtimeOpenAiConfiguration(tx, own));
    expect(runtime.apiKey).toBe(OWN);
    expect(runtime.anthropicApiKey).toBeUndefined();
    // The settings view says the same, never showing a key.
    const view = await run(own, (tx) => projectAiConfigurationView(tx, own));
    expect(view.providers.anthropic).toEqual({ keyConfigured: false, source: "none" });
    expect(JSON.stringify(view)).not.toContain(OWN);
  });

  it("refuses a first save that would leave the project without a key under v2", async () => {
    const fresh = await project("First save");
    process.env.ORBIT_AI_KEY_RULE_V2 = "true";
    await expect(
      run(fresh, (tx) =>
        saveAiProviderConfiguration(tx, fresh, { defaultProvider: "openai" }),
      ),
    ).rejects.toMatchObject({ code: "ANTHROPIC_API_KEY_REQUIRED" });
    const { apiKey: _key, ...withoutKey } = openAiInput;
    await expect(
      run(fresh, (tx) => saveOpenAiConfiguration(tx, fresh, withoutKey)),
    ).rejects.toMatchObject({ code: "OPENAI_API_KEY_REQUIRED" });
    // Before v2 the environment Anthropic key allowed it, as it did.
    delete process.env.ORBIT_AI_KEY_RULE_V2;
    await run(fresh, (tx) => saveOpenAiConfiguration(tx, fresh, withoutKey));
  });

  it("reports per project what the switch would take away, without keys", async () => {
    const report = await keyRuleReport({ workspaceId: scope.workspaceId });
    const byName = (name: string) => report.find((r) => r.name === name)!;
    expect(byName("Unsaved")).toMatchObject({ lostKeys: [], actionRequired: false });
    expect(byName("Saved with an own OpenAI key")).toMatchObject({
      lostKeys: ["anthropic"],
      actionRequired: true,
    });
    // The first-save project lost its environment OpenAI key already; v2 takes Anthropic.
    expect(byName("First save")).toMatchObject({ lostKeys: ["anthropic"] });
    const text = JSON.stringify(report);
    for (const key of [ENV_OPENAI, ENV_ANTHROPIC, OWN]) expect(text).not.toContain(key);
    // The live rule is unchanged by the report.
    const own = report.find((r) => r.name === "Saved with an own OpenAI key")!;
    const status = await scoped(scope.workspaceId, own.projectId, (tx) =>
      effectiveAiStatus(tx, { ...scope, projectId: own.projectId }),
    );
    expect(status.keySources.anthropic).toBe("environment");
  });
});
