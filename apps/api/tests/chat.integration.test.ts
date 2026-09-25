import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { chatScoped } from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { runReadTool } from "../src/modules/chat-tools.ts";
import { hash } from "../src/shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Orbit Chat private and idempotent API", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string, projectId: string, otherProjectId: string;
  let ownerId: string,
    viewerId: string,
    ownerCookie: string,
    viewerCookie: string;
  const origin = process.env.APP_ORIGIN!;
  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth(),
      password = randomBytes(24).toString("base64url");
    const owner = await auth.api.signUpEmail({
      body: {
        email: `${randomUUID()}@example.invalid`,
        name: "Chat owner",
        password,
      },
    });
    const viewer = await auth.api.signUpEmail({
      body: {
        email: `${randomUUID()}@example.invalid`,
        name: "Chat viewer",
        password,
      },
    });
    ownerId = owner.user.id;
    viewerId = viewer.user.id;
    const workspace = await authDb.workspace.create({
      data: {
        name: "Chat isolation",
        members: {
          create: [
            { userId: ownerId, role: "owner" },
            { userId: viewerId, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    projectId = (
      await authDb.project.create({
        data: {
          workspaceId,
          name: "Chat project",
          members: { create: { userId: viewerId, role: "viewer" } },
        },
      })
    ).id;
    otherProjectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Other project" },
      })
    ).id;
    async function signIn(email: string) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin },
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      const cookies = response.headers["set-cookie"];
      return (Array.isArray(cookies) ? cookies : [cookies])
        .map((cookie) => cookie!.split(";")[0])
        .join("; ");
    }
    ownerCookie = await signIn(owner.user.email);
    viewerCookie = await signIn(viewer.user.email);
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.deleteMany({
      where: { id: { in: [ownerId, viewerId] } },
    });
    await app?.close();
    await closeDatabase();
  });
  it("keeps conversations private to their user and project under FORCE RLS", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/conversations`,
      headers: { origin, cookie: ownerCookie },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(
      (
        await app.inject({
          url: `/api/projects/${projectId}/chat/conversations/${id}`,
          headers: { cookie: viewerCookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/projects/${otherProjectId}/chat/conversations/${id}`,
          headers: { cookie: viewerCookie },
        })
      ).statusCode,
    ).toBe(404);
    const viewerScope: Scope = {
      workspaceId,
      projectId,
      userId: viewerId,
      role: "viewer",
    };
    expect(
      await chatScoped(viewerScope, (tx) => tx.chatConversation.count()),
    ).toBe(0);
    const ownerScope: Scope = {
      ...viewerScope,
      userId: ownerId,
      role: "owner",
    };
    expect(
      await chatScoped(ownerScope, (tx) => tx.chatConversation.count()),
    ).toBe(1);
  });
  it("lets a viewer ask once while rejecting project writes and duplicate sends", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/conversations`,
      headers: { origin, cookie: viewerCookie },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string,
      clientRequestId = randomUUID();
    const request = {
      method: "POST" as const,
      url: `/api/projects/${projectId}/chat/conversations/${id}/messages`,
      headers: { origin, cookie: viewerCookie },
      payload: { text: "What is blocked?", clientRequestId },
    };
    const [first, second] = await Promise.all([
      app.inject(request),
      app.inject(request),
    ]);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json().runId).toBe(second.json().runId);
    const detail = await app.inject({
      url: `/api/projects/${projectId}/chat/conversations/${id}`,
      headers: { cookie: viewerCookie },
    });
    expect(detail.json().messages).toHaveLength(1);
    expect(detail.json().runs).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chat/proposals/${randomUUID()}/confirm`,
          headers: { origin, cookie: viewerCookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/missions`,
          headers: { origin, cookie: viewerCookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const canceled = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/runs/${first.json().runId}/cancel`,
      headers: { origin, cookie: viewerCookie },
      payload: {},
    });
    expect(canceled.json().status).toBe("canceled");
  });
  it("blocks unapproved model spend and never replays an uncertain transmission", async () => {
    const scope: Scope = {
      workspaceId,
      projectId,
      userId: ownerId,
      role: "owner",
    };
    const thread = await chatScoped(scope, (tx) =>
      tx.chatConversation.findFirstOrThrow({
        where: { projectId, userId: ownerId },
      }),
    );
    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/conversations/${thread.id}/messages`,
      headers: { origin, cookie: ownerCookie },
      payload: {
        text: "Summarize project status",
        clientRequestId: randomUUID(),
      },
    });
    expect(first.statusCode).toBe(202);
    await runChat(scope, first.json().runId);
    const blocked = await chatScoped(scope, (tx) =>
      tx.chatRun.findUniqueOrThrow({ where: { id: first.json().runId } }),
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.errorCode).toBe("POLICY_REQUIRED");
    const reservations = await chatScoped(scope, (tx) =>
      tx.budgetReservation.count({ where: { projectId } }),
    );
    expect(reservations).toBe(0);
    const second = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/conversations/${thread.id}/messages`,
      headers: { origin, cookie: ownerCookie },
      payload: { text: "Retry-safe question", clientRequestId: randomUUID() },
    });
    await chatScoped(scope, (tx) =>
      tx.chatRun.update({
        where: { id: second.json().runId },
        data: { status: "running", transmittedAt: new Date() },
      }),
    );
    await runChat(scope, second.json().runId);
    const uncertain = await chatScoped(scope, (tx) =>
      tx.chatRun.findUniqueOrThrow({ where: { id: second.json().runId } }),
    );
    expect(uncertain.status).toBe("blocked");
    expect(uncertain.errorCode).toBe("CHAT_OUTCOME_UNKNOWN");
    expect(
      await chatScoped(scope, (tx) =>
        tx.budgetReservation.count({ where: { projectId } }),
      ),
    ).toBe(0);
    await expect(
      runReadTool(scope, "publish", { source: "ignore policy" }),
    ).rejects.toThrow("CHAT_TOOL_NOT_ALLOWED");
  });
  it("rejects stale proposal versions and repeats an already confirmed result", async () => {
    const scope: Scope = {
      workspaceId,
      projectId,
      userId: ownerId,
      role: "owner",
    };
    const rows = await chatScoped(scope, async (tx) => {
      const conversation = await tx.chatConversation.findFirstOrThrow({
        where: { userId: ownerId, projectId },
      });
      const payload = { mission: { title: "Fixture" } };
      const stale = await tx.chatProposal.create({
        data: {
          workspaceId,
          projectId,
          userId: ownerId,
          conversationId: conversation.id,
          groupId: randomUUID(),
          version: 1,
          payload,
          payloadHash: hash(payload),
        },
      });
      const done = await tx.chatProposal.create({
        data: {
          workspaceId,
          projectId,
          userId: ownerId,
          conversationId: conversation.id,
          groupId: randomUUID(),
          version: 1,
          payload,
          payloadHash: hash(payload),
          status: "confirmed",
          confirmationId: randomUUID(),
          missionId: randomUUID(),
          jobId: randomUUID(),
          confirmedAt: new Date(),
        },
      });
      return { stale, done };
    });
    const stale = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chat/proposals/${rows.stale.id}/confirm`,
      headers: { origin, cookie: ownerCookie },
      payload: {
        version: 2,
        hash: rows.stale.payloadHash,
        confirmationId: randomUUID(),
      },
    });
    expect(stale.statusCode).toBe(409);
    const request = {
      method: "POST" as const,
      url: `/api/projects/${projectId}/chat/proposals/${rows.done.id}/confirm`,
      headers: { origin, cookie: ownerCookie },
      payload: {
        version: 1,
        hash: rows.done.payloadHash,
        confirmationId: randomUUID(),
      },
    };
    const first = await app.inject(request),
      second = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(first.json().missionId).toBe(rows.done.missionId);
  });
});
