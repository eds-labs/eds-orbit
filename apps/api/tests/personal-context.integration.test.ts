import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  contextForPrompt,
  groundedInUserText,
  listContext,
  screenContextText,
  type ContextEntry,
} from "../src/platform/assistant/personal-context.ts";

// The personal assistant's routes and personal context (ADR 0022, D-17):
// GET /api/assistant provisions the user's own space; entries pass the
// deterministic screen, are versioned, deleted without leftovers, exported,
// and never readable by anyone but their user.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_PERSONAL_ASSISTANT: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

type Person = { id: string; email: string; cookie?: string };

describe("personal context screen and prompt selection", () => {
  it("refuses contact data, secrets, health and financial details", () => {
    for (const text of [
      "Write to anna.meier@example.com about the launch",
      "Call me on +49 170 1234567",
      "My IBAN is DE89 3704 0044 0532 0130 00",
      "password: hunter2hunter2",
      // Split so scripts/check-secrets.py does not flag the fixture.
      `Use key sk-${"abcdefghijklmnopqrstuvwxyz123456"}`,
      "I was diagnosed with diabetes last year",
      "Ich nehme ein neues Medikament",
      "My salary is 80k",
      "Mein Kontostand ist niedrig",
    ])
      expect(screenContextText(text), text).not.toBeNull();
    for (const text of [
      "Prefers short answers in German",
      "Weekly marketing review on Mondays",
      "Use the Support agent for billing questions first",
      "Bevorzugt Stichpunkte statt Fließtext",
    ])
      expect(screenContextText(text), text).toBeNull();
  });

  it("accepts an assistant entry only when it rests on what the user said", () => {
    expect(
      groundedInUserText("Prefers short answers in German", "Please always give me short answers, in German."),
    ).toBe(true);
    expect(
      groundedInUserText("Ticket 4711 is about a refund dispute", "what's new in support?"),
    ).toBe(false);
  });

  it("includes active entries within 2 KB, project entries only in their project's turn", () => {
    const base = { version: 1, createdBy: "user", createdAt: new Date().toISOString() } as const;
    const entries: ContextEntry[] = [
      { ...base, id: "a", category: "preference", text: "Short answers", projectId: null, status: "active" },
      { ...base, id: "b", category: "project_note", text: "Launch on Friday", projectId: "p1", status: "active" },
      { ...base, id: "c", category: "decision", text: "Old decision", projectId: null, status: "archived" },
      ...Array.from({ length: 30 }, (_, i) => ({
        ...base,
        id: `f${i}`,
        category: "workflow" as const,
        text: "x".repeat(120),
        projectId: null,
        status: "active" as const,
      })),
    ];
    const none = contextForPrompt(entries, new Set());
    expect(none.map((e) => e.id)).toContain("a");
    expect(none.map((e) => e.id)).not.toContain("b");
    expect(none.map((e) => e.id)).not.toContain("c");
    expect(contextForPrompt(entries, new Set(["p1"])).map((e) => e.id)).toContain("b");
    const bytes = none.reduce((n, e) => n + Buffer.byteLength(`- (${e.category}) ${e.text}\n`), 0);
    expect(bytes).toBeLessThanOrEqual(2048);
  });
});

describe.skipIf(!enabled)("Personal assistant routes (ADR 0022)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  let workspaceId: string;
  let spaceId: string;
  const p: Record<"owner" | "member", Person> = {} as never;

  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string) {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({ body: { email, name, password } });
    users.push(r.user.id);
    return { id: r.user.id, email };
  }
  async function signIn(person: Person) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email: person.email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    person.cookie = (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  }
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    who: Person,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: who.cookie! },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  beforeAll(async () => {
    app = await buildServer();
    p.owner = await signUp("Synthetic context owner");
    p.member = await signUp("Synthetic context member");
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic personal-context org",
          members: {
            create: [
              { userId: p.owner.id, role: "owner" },
              { userId: p.member.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    await signIn(p.owner);
    await signIn(p.member);
  });

  afterAll(async () => {
    if (workspaceId) await authDb.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("provisions the user's own space once and reports the cap and memory mode", async () => {
    const first = await call("GET", `/api/assistant?workspaceId=${workspaceId}`, p.member);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ enabled: true, workspaceId, capMicros: null, autoMemory: true });
    spaceId = first.json().personalSpaceId;
    const again = await call("GET", "/api/assistant", p.member);
    expect(again.json().personalSpaceId).toBe(spaceId);
    const owner = await call("GET", `/api/assistant?workspaceId=${workspaceId}`, p.owner);
    expect(owner.json().personalSpaceId).not.toBe(spaceId);

    await authDb.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: p.member.id } },
      data: { assistantEnabled: false },
    });
    expect((await call("GET", "/api/assistant", p.member)).json()).toEqual({
      enabled: false,
      workspaceId,
      reason: "ASSISTANT_DISABLED_FOR_MEMBER",
    });
    expect((await call("GET", "/api/assistant/context", p.member)).statusCode).toBe(403);
    await authDb.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: p.member.id } },
      data: { assistantEnabled: true },
    });
    // Another organization's id is not the user's.
    expect((await call("GET", `/api/assistant?workspaceId=${randomUUID()}`, p.member)).statusCode).toBe(404);
    process.env.ORBIT_PERSONAL_ASSISTANT = "false";
    try {
      expect((await call("GET", "/api/assistant", p.member)).statusCode).toBe(404);
      expect((await call("GET", "/api/assistant/context", p.member)).statusCode).toBe(404);
    } finally {
      process.env.ORBIT_PERSONAL_ASSISTANT = "true";
    }
  });

  it("stores, screens, edits, exports and deletes entries without leftovers", async () => {
    const created = await call("POST", "/api/assistant/context", p.member, {
      category: "preference",
      text: "Prefers short answers in German",
    });
    expect(created.statusCode).toBe(201);
    const entry = created.json();
    expect(entry).toMatchObject({ status: "active", createdBy: "user", projectId: null, version: 1 });
    const refused = await call("POST", "/api/assistant/context", p.member, {
      category: "preference",
      text: "My password: correct-horse-battery",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe("PERSONAL_CONTEXT_NOT_ALLOWED");
    const patched = await call("PATCH", `/api/assistant/context/${entry.id}`, p.member, {
      version: 1,
      text: "Prefers short answers, in German",
    });
    expect(patched.json()).toMatchObject({ version: 2, text: "Prefers short answers, in German" });
    expect(
      (await call("PATCH", `/api/assistant/context/${entry.id}`, p.member, { version: 1, status: "archived" }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call("PATCH", `/api/assistant/context/${entry.id}`, p.member, { version: 2, text: "I take medication daily" }))
        .statusCode,
    ).toBe(400);
    const settings = await call("PUT", "/api/assistant/context/settings", p.member, { autoMemory: false });
    expect(settings.json()).toEqual({ autoMemory: false });
    const listed = (await call("GET", "/api/assistant/context", p.member)).json();
    expect(listed.autoMemory).toBe(false);
    expect(listed.items.map((x: { id: string }) => x.id)).toEqual([entry.id]);
    const exported = await call("GET", "/api/assistant/context/export", p.member);
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.json().entries[0].text).toBe("Prefers short answers, in German");

    // The org owner's own context is separate; the member's space is not theirs.
    expect((await call("GET", "/api/assistant/context", p.owner)).json().items).toEqual([]);
    await expect(
      scoped(workspaceId, spaceId, (tx) =>
        listContext(tx, { workspaceId, projectId: spaceId, userId: p.owner.id, role: "owner" } as Scope),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await call("DELETE", `/api/assistant/context/${entry.id}`, p.owner)).statusCode).toBe(404);

    expect((await call("DELETE", `/api/assistant/context/${entry.id}`, p.member)).statusCode).toBe(204);
    const leftovers = await scoped(workspaceId, spaceId, (tx) =>
      Promise.all([
        tx.entity.count({ where: { id: entry.id } }),
        tx.entityVersion.count({ where: { entityId: entry.id } }),
      ]),
    );
    expect(leftovers).toEqual([0, 0]);
    // The audit trail names the entry, never its text.
    const audits = await scoped(workspaceId, spaceId, (tx) =>
      tx.auditEvent.findMany({ where: { projectId: spaceId, resourceId: entry.id } }),
    );
    expect(audits.map((a) => a.action).sort()).toEqual([
      "personal_context.added",
      "personal_context.changed",
      "personal_context.deleted",
    ]);
    expect(JSON.stringify(audits)).not.toContain("short answers");
  });
});
