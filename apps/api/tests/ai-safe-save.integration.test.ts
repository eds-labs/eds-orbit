import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  projectAiConfigurationView,
  saveAiProviderConfiguration,
  saveAiRouting,
  saveOpenAiConfiguration,
} from "../src/platform/ai/openai-configuration.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * The project view carries the project's own saved AI fields next to the
 * effective ones, so a form can send back only what is stored (settings
 * center phase 4): environment values and presets must never leak into a save.
 */
describe.skipIf(!enabled)("AI safe save: stored configuration in the view", () => {
  let scope: Scope;
  const users: string[] = [];
  const workspaces: string[] = [];
  const OWN = `sk-own-${randomBytes(12).toString("hex")}`;
  const saved = { ...process.env };
  const rate = {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 2_000_000,
    verifiedAt: new Date().toISOString(),
  };
  const models = [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "claude-haiku-5-5",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
  ];
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
        name: "Synthetic safe save owner",
        emailVerified: true,
      },
    });
    users.push(user.id);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic safe save",
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
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_AI_CATALOG = "true";
    process.env.ORBIT_AI_DEFAULTS = "true";
    process.env.OPENAI_API_KEY = `sk-env-${randomBytes(12).toString("hex")}`;
    process.env.OPENAI_VERIFIED_MODELS = "gpt-5.6-luna,gpt-5.6-terra";
  });
  afterAll(async () => {
    for (const key of [
      "ORBIT_CONNECTIONS",
      "ORBIT_AI_CATALOG",
      "ORBIT_AI_DEFAULTS",
      "OPENAI_API_KEY",
      "OPENAI_VERIFIED_MODELS",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("reports no stored configuration for an unsaved project", async () => {
    const unsaved = await project("Unsaved");
    const view = await run(unsaved, (tx) => projectAiConfigurationView(tx, unsaved));
    expect(view.stored).toBeNull();
    // Environment values, as before.
    expect(view.verifiedModels).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });

  it("reports the stored default provider of a project on a preset, not the effective one", async () => {
    const preset = await project("On a preset");
    await run(preset, (tx) =>
      saveOpenAiConfiguration(tx, preset, {
        apiKey: OWN,
        verifiedModels: models,
        rateCard: Object.fromEntries(models.map((m) => [m, rate])),
      }),
    );
    await run(preset, (tx) =>
      saveAiProviderConfiguration(tx, preset, { defaultProvider: "openai" }),
    );
    await run(preset, (tx) =>
      saveAiRouting(tx, preset, {
        source: "preset",
        provider: "anthropic",
        level: "balanced",
        overrides: {},
      }),
    );
    const view = await run(preset, (tx) => projectAiConfigurationView(tx, preset));
    expect(view.defaultProvider).toBe("anthropic");
    expect(view.stored).toMatchObject({
      defaultProvider: "openai",
      verifiedModels: models,
      routing: { source: "preset", provider: "anthropic" },
    });
    expect(JSON.stringify(view.stored)).not.toMatch(/encrypted|sk-/);
  });
});
