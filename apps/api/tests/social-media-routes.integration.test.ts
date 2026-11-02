import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

/**
 * Media routes (ADR 0020, S3): everybody in the module reads the library
 * and the images; owners and editors upload, edit and remove; another
 * project's members see nothing.
 */
describe.skipIf(!enabled)("social media routes", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (who: keyof typeof ids, method: "GET" | "PATCH" | "DELETE", url: string, payload?: object, project = projectId) =>
    app.inject({
      method,
      url: `/api/projects/${project}/social${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const upload = (who: keyof typeof ids, body: Buffer = PNG, type = "application/octet-stream", project = projectId) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${project}/social/media`,
      headers: {
        origin,
        cookie: cookies[who],
        [CLIENT_IP_HEADER]: ip(),
        "content-type": type,
        "x-file-name": encodeURIComponent("Launch Banner.png"),
        "x-file-type": "image/png",
      },
      payload: body,
    });

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic social ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic social media",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social media" } })).id;
    otherProjectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic social media B" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
    await scoped(workspaceId, projectId, (tx) =>
      tx.projectModule.create({
        data: { workspaceId, projectId, moduleId: "social", enabled: true, moduleVersion: "0.1.0", changedBy: ids.owner },
      }),
    );
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set]).map((v) => v!.split(";")[0]).join("; ");
    }
  });
  beforeEach(() => {
    process.env.ORBIT_SOCIAL = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_SOCIAL;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("lets an editor upload and a viewer read the library and the image", async () => {
    const created = await upload("editor");
    expect(created.statusCode).toBe(201);
    const media = created.json();
    expect(media).toMatchObject({ name: "Launch Banner.png", mime: "image/png", width: 800, height: 600 });
    const list = await call("viewer", "GET", "/media");
    expect(list.json().items.map((i: { id: string }) => i.id)).toContain(media.id);
    const content = await call("viewer", "GET", `/media/${media.id}/content?rendition=jpeg`);
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/jpeg");
    expect(content.headers["content-disposition"]).toMatch(/^inline/);
    expect(content.headers["x-content-type-options"]).toBe("nosniff");
    expect(content.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(content.headers["cache-control"]).toBe("private, no-store");
    expect(content.rawPayload[0]).toBe(0xff);
  });

  it("refuses uploads, edits and removal by a viewer", async () => {
    expect((await upload("viewer")).statusCode).toBe(403);
    const media = (await upload("owner")).json();
    expect((await call("viewer", "PATCH", `/media/${media.id}`, { altText: "x", version: 1 })).statusCode).toBe(403);
    expect((await call("viewer", "DELETE", `/media/${media.id}`)).statusCode).toBe(403);
  });

  it("lets an editor describe and remove an image", async () => {
    const media = (await upload("editor")).json();
    const saved = await call("editor", "PATCH", `/media/${media.id}`, { altText: "Launch banner", version: 1 });
    expect(saved.json()).toMatchObject({ altText: "Launch banner", version: 2 });
    const removed = await call("editor", "DELETE", `/media/${media.id}`);
    expect(removed.json()).toEqual({ id: media.id, removed: "deleted" });
    expect((await call("viewer", "GET", `/media/${media.id}/content`)).statusCode).toBe(404);
  });

  it("refuses another content type before reading the body", async () => {
    const response = await upload("editor", Buffer.from("{}"), "application/json");
    expect([response.statusCode, response.json().error?.code]).toEqual([415, "FILE_BODY_REQUIRED"]);
  });

  it("hides the project from members of another project", async () => {
    expect((await upload("editor", PNG, "application/octet-stream", otherProjectId)).statusCode).toBe(404);
    expect((await call("editor", "GET", "/media", undefined, otherProjectId)).statusCode).toBe(404);
  });

  it("answers 404 SOCIAL_DISABLED while the module is off", async () => {
    delete process.env.ORBIT_SOCIAL;
    const response = await upload("editor");
    expect([response.statusCode, response.json().error?.code]).toEqual([404, "SOCIAL_DISABLED"]);
  });
});
