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
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const enabledHttp = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

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

/**
 * The AI profile `PUT` takes an optional expected version (settings center
 * phase 4, risk 7): an editor that loaded the profile before its standard
 * models changed may not write the old copy back over them.
 */
describe.skipIf(!enabledHttp)("AI safe save: profile version check over HTTP", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let w = "";
  const cookies = { owner: "", admin: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const flags = [
    "ORBIT_ADMINISTRATION",
    "ORBIT_CONNECTIONS",
    "ORBIT_AI_CATALOG",
    "ORBIT_AI_DEFAULTS",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let ip = 40;
  const signUp = async (name: string) => {
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name, password },
    });
    users.push(created.user.id);
    return { id: created.user.id, email, password };
  };
  const signIn = async (who: { email: string; password: string }) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: `198.18.9.${ip++}` },
      payload: { email: who.email, password: who.password },
    });
    expect(res.statusCode).toBe(200);
    const set = res.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
  };
  const call = (
    method: "GET" | "PUT",
    url: string,
    payload?: unknown,
    cookie = cookies.owner,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const body = { verifiedModels: ["m3"] };

  beforeAll(async () => {
    for (const key of flags) {
      saved[key] = process.env[key];
      process.env[key] = "true";
    }
    app = await buildServer();
    const owner = await signUp("Synthetic version check owner");
    const admin = await signUp("Synthetic version check admin");
    await authDb.user.update({ where: { id: admin.id }, data: { role: "admin" } });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic version check",
        members: { create: { userId: owner.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    w = workspace.id;
    cookies.owner = await signIn(owner);
    cookies.admin = await signIn(admin);
  });
  afterAll(async () => {
    for (const key of flags)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("refuses a stale profile save and keeps the stored profile (risk 7)", async () => {
    const first = await call("PUT", `/api/organizations/${w}/ai/profile`, {
      verifiedModels: ["m1"],
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().version).toBe(1);
    const standard = await call("PUT", `/api/organizations/${w}/ai/defaults`, {
      provider: "anthropic",
      level: "balanced",
    });
    expect(standard.statusCode).toBe(200);
    expect(standard.json().version).toBe(2);
    const stale = await call(
      "PUT",
      `/api/organizations/${w}/ai/profile?expectedVersion=1`,
      { verifiedModels: ["m2"] },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("AI_PROFILE_VERSION_CONFLICT");
    const now = (await call("GET", `/api/organizations/${w}/ai/profile`)).json();
    expect(now.version).toBe(2);
    expect(now.data.defaults).toBeDefined();
    expect(now.data.verifiedModels).toEqual(["m1"]);
  });

  it("saves with the current version and without one, as before", async () => {
    const current = await call(
      "PUT",
      `/api/organizations/${w}/ai/profile?expectedVersion=2`,
      body,
    );
    expect(current.statusCode).toBe(200);
    expect(current.json().version).toBe(3);
    const unchecked = await call("PUT", `/api/organizations/${w}/ai/profile`, body);
    expect(unchecked.statusCode).toBe(200);
    expect(unchecked.json().version).toBe(4);
  });

  it("refuses a first save that expects an existing profile", async () => {
    const other = await authDb.workspace.create({
      data: {
        name: "Synthetic version check, no profile",
        members: { create: { userId: users[0]!, role: "owner" } },
      },
    });
    workspaces.push(other.id);
    const res = await call(
      "PUT",
      `/api/organizations/${other.id}/ai/profile?expectedVersion=1`,
      body,
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("AI_PROFILE_VERSION_CONFLICT");
    expect(
      await authDb.aiProfile.count({ where: { workspaceId: other.id } }),
    ).toBe(0);
    const firstSave = await call(
      "PUT",
      `/api/organizations/${other.id}/ai/profile?expectedVersion=0`,
      body,
    );
    expect(firstSave.statusCode).toBe(200);
  });

  it("refuses an unknown query parameter", async () => {
    expect(
      (await call("PUT", `/api/admin/ai/profile?version=1`, body, cookies.admin))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("PUT", `/api/organizations/${w}/ai/profile?version=1`, body))
        .statusCode,
    ).toBe(400);
  });
});
