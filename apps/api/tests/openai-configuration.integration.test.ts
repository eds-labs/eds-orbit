import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeAuth } from "../src/auth.ts";
import { buildServer } from "../src/server.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const rate = (verifiedAt: string) => ({
  inputMicrosPerMillion: 1,
  outputMicrosPerMillion: 1,
  verifiedAt,
});

describe.skipIf(!enabled)("OpenAI configuration task routes API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;
  let projectId: string;
  let ownerId: string;
  let editorId: string;
  let ownerCookie: string;
  let editorCookie: string;
  const origin = process.env.APP_ORIGIN!;

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const password = randomBytes(24).toString("base64url");
    const owner = await auth.api.signUpEmail({
      body: {
        email: randomUUID() + "@example.invalid",
        name: "Synthetic route owner",
        password,
      },
    });
    const editor = await auth.api.signUpEmail({
      body: {
        email: randomUUID() + "@example.invalid",
        name: "Synthetic route editor",
        password,
      },
    });
    ownerId = owner.user.id;
    editorId = editor.user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic route configuration",
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            { userId: editorId, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Routes",
          members: { create: { userId: editorId, role: "editor" } },
        },
      })
    ).id;
    async function signIn(email: string) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin },
        payload: { email, password },
      });
      expect(r.statusCode).toBe(200);
      const cookies = r.headers["set-cookie"];
      return (Array.isArray(cookies) ? cookies : [cookies])
        .map((c) => c!.split(";")[0])
        .join("; ");
    }
    ownerCookie = await signIn(owner.user.email);
    editorCookie = await signIn(editor.user.email);
  });

  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: [ownerId, editorId] } } });
    await app?.close();
    await closeDatabase();
  });

  it("round-trips task routes, bumps routeVersion and keeps saving owner-only", async () => {
    const now = new Date().toISOString();
    const body = (maxOutputTokens: number) => ({
      apiKey: "synthetic-key-" + "x".repeat(20),
      verifiedModels: ["m-fast", "m-standard", "m-quality", "m-blog"],
      rateCard: { "m-blog": rate(now) },
      modelRoutes: {
        fast: "m-fast",
        standard: "m-standard",
        quality: "m-quality",
        escalation: "m-escalation",
      },
      taskRoutes: {
        draft_blog: {
          model: "m-blog",
          reasoningEffort: "low",
          maxOutputTokens,
        },
      },
    });
    const url = `/api/projects/${projectId}/actions/openai-configure`;
    const first = await app.inject({
      method: "POST",
      url,
      headers: { origin, cookie: ownerCookie },
      payload: body(4000),
    });
    expect(first.statusCode).toBe(200);
    const get = await app.inject({
      url: `/api/projects/${projectId}/openai-configuration`,
      headers: { cookie: ownerCookie },
    });
    expect(get.statusCode).toBe(200);
    const view = get.json();
    expect(view.taskRoutes.draft_blog).toEqual({
      model: "m-blog",
      reasoningEffort: "low",
      maxOutputTokens: 4000,
    });
    expect(view.effectiveRoutes.draft_blog.model).toBe("m-blog");
    expect(view.effectiveRoutes.draft_social.model).toBe("m-standard");
    expect(JSON.stringify(view)).not.toContain("synthetic-key");
    expect(typeof view.routeVersion).toBe("number");
    const second = await app.inject({
      method: "POST",
      url,
      headers: { origin, cookie: ownerCookie },
      payload: body(5000),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().routeVersion).toBe(view.routeVersion + 1);
    expect(second.json().taskRoutes.draft_blog.maxOutputTokens).toBe(5000);
    const denied = await app.inject({
      method: "POST",
      url,
      headers: { origin, cookie: editorCookie },
      payload: body(6000),
    });
    expect(denied.statusCode).toBe(403);
    const after = await app.inject({
      url: `/api/projects/${projectId}/openai-configuration`,
      headers: { cookie: ownerCookie },
    });
    expect(after.json().taskRoutes.draft_blog.maxOutputTokens).toBe(5000);
  });
});
