import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

// The Google token exchange itself is covered by google-drive.mock.test.ts;
// this file pins where the browser lands afterwards.
const finish = vi.hoisted(() => vi.fn());
vi.mock("../src/platform/connections/google-drive.ts", async (original) => ({
  ...(await original<
    typeof import("../src/platform/connections/google-drive.ts")
  >()),
  finishConnect: finish,
}));

import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("Google Drive OAuth callback redirect", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  let userId: string, workspaceId: string, projectId: string, cookie: string;
  let editorId: string, editorCookie: string;

  const signInAs = async (email: string) => {
    const signIn = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: {
        origin,
        [CLIENT_IP_HEADER]: `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`,
      },
      payload: { email, password },
    });
    expect(signIn.statusCode).toBe(200);
    const set = signIn.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  };
  const callback = (state: string, as = cookie) =>
    app.inject({
      method: "GET",
      url: `/api/google-drive/callback?code=synthetic-code&state=${state}`,
      headers: {
        origin,
        cookie: as,
        [CLIENT_IP_HEADER]: `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`,
      },
    });
  // The state starts with the project id the flow was begun for.
  const stateFor = (id: string) => `${id}.${randomBytes(24).toString("hex")}`;

  beforeAll(async () => {
    app = await buildServer();
    const email = `${randomUUID()}@example.invalid`;
    const created = await makeAuth().api.signUpEmail({
      body: { email, name: "Synthetic drive owner", password },
    });
    userId = created.user.id;
    const editorEmail = `${randomUUID()}@example.invalid`;
    editorId = (
      await makeAuth().api.signUpEmail({
        body: { email: editorEmail, name: "Synthetic drive editor", password },
      })
    ).user.id;
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic drive callback org",
          members: {
            create: [
              { userId, role: "viewer" },
              { userId: editorId, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Synthetic drive callback project",
          members: {
            create: [
              { userId, role: "owner" },
              { userId: editorId, role: "editor" },
            ],
          },
        },
      })
    ).id;
    cookie = await signInAs(email);
    editorCookie = await signInAs(editorEmail);
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: [userId, editorId] } } });
    await app?.close();
    await closeDatabase();
  });

  it("returns to the project the flow belongs to, with the outcome", async () => {
    finish.mockResolvedValueOnce(true);
    const ready = await callback(stateFor(projectId));
    expect(ready.statusCode).toBe(302);
    expect(ready.headers.location).toBe(
      `${origin}/manage/p/${projectId}/integrations/google-drive?googleDrive=ready`,
    );
    finish.mockResolvedValueOnce(false);
    const choose = await callback(stateFor(projectId));
    expect(choose.statusCode).toBe(302);
    expect(choose.headers.location).toBe(
      `${origin}/manage/p/${projectId}/integrations/google-drive?googleDrive=choose-root`,
    );
  });

  it("answers an error and no redirect when the state names no project of the member", async () => {
    finish.mockClear();
    const foreign = await callback(stateFor(randomUUID()));
    expect(foreign.statusCode).toBeGreaterThanOrEqual(400);
    expect(foreign.headers.location).toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses a project member below owner without a redirect", async () => {
    finish.mockClear();
    const refused = await callback(stateFor(projectId), editorCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.headers.location).toBeUndefined();
    expect(finish).not.toHaveBeenCalled();
  });
});
