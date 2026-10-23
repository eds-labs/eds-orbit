import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import {
  authDb,
  closeDatabase,
  scoped,
  type Prisma,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { ingest } from "../src/platform/knowledge/engine.ts";
import {
  knowledgeSearch,
  validateSearchResult,
} from "../src/platform/knowledge/search.ts";

// Organization knowledge libraries and shares (ADR 0014, E1): only an
// explicit share brings library results into a project, with origin, and
// every change to the share or the library invalidates them.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_ADMINISTRATION: "true",
  ORBIT_KNOWLEDGE_SHARES: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
});

const TOKEN = `zephyrine${randomBytes(4).toString("hex")}`;
const HOUR = 3600_000;

type Result = {
  status: string;
  passages: Array<{ chunkId: string; origin?: { shareId: string } }>;
  retrieval: { evidenceId: string; shared?: unknown[] };
};

describe.skipIf(!enabled)("Knowledge shares (ADR 0014)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const origin = process.env.APP_ORIGIN!;
  const password = randomBytes(24).toString("base64url");
  const users: string[] = [];
  const workspaces: string[] = [];
  let owner: { id: string; cookie: string };
  let outsider: { id: string; cookie: string };
  let ws: string, other: string, c1: string, c2: string, d1: string;
  let library: string, sourceId: string, shareId: string;
  const scope = (workspaceId: string, projectId: string): Scope => ({
    workspaceId,
    projectId,
    userId: owner.id,
    role: "owner",
  });
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    who: { cookie: string },
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, [CLIENT_IP_HEADER]: ip(), cookie: who.cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const search = async (projectId: string, consumer = "support", shared = true) =>
    (
      await knowledgeSearch(scope(ws, projectId), { query: TOKEN }, undefined, consumer, undefined, { shared })
    ).result as Result;

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    const people: Record<string, { id: string; email: string }> = {};
    for (const key of ["owner", "outsider"]) {
      const email = `${randomUUID()}@example.invalid`;
      const r = await auth.api.signUpEmail({ body: { email, name: `Synthetic ${key}`, password } });
      users.push(r.user.id);
      people[key] = { id: r.user.id, email };
    }
    const a = await authDb.workspace.create({
      data: {
        name: "Synthetic shares",
        members: { create: { userId: people.owner!.id, role: "owner" } },
        projects: { create: [{ name: "C1" }, { name: "C2" }] },
      },
      include: { projects: true },
    });
    const b = await authDb.workspace.create({
      data: {
        name: "Synthetic shares other",
        members: { create: { userId: people.outsider!.id, role: "owner" } },
        projects: { create: [{ name: "D1" }] },
      },
      include: { projects: true },
    });
    workspaces.push(a.id, b.id);
    ws = a.id;
    other = b.id;
    c1 = a.projects.find((p) => p.name === "C1")!.id;
    c2 = a.projects.find((p) => p.name === "C2")!.id;
    d1 = b.projects[0]!.id;
    const cookies: Record<string, string> = {};
    for (const key of ["owner", "outsider"]) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email: people[key]!.email, password },
      });
      const set = r.headers["set-cookie"];
      cookies[key] = (Array.isArray(set) ? set : [set]).map((c) => c!.split(";")[0]).join("; ");
    }
    owner = { id: people.owner!.id, cookie: cookies.owner! };
    outsider = { id: people.outsider!.id, cookie: cookies.outsider! };
    const created = await call("POST", `/api/organizations/${ws}/knowledge-libraries`, owner, { name: "Company handbook" });
    expect(created.statusCode).toBe(201);
    library = created.json().id;
    sourceId = await scoped(ws, library, async (tx) => {
      const row = await tx.entity.create({
        data: {
          workspaceId: ws,
          projectId: library,
          kind: "sources",
          data: {
            name: "Handbook",
            type: "file",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: true,
            authority: "official",
            maxAgeHours: 168,
            allowedOrigins: [],
            allowedPaths: [],
          },
        },
      });
      await ingest(tx, scope(ws, library), {
        sourceId: row.id,
        externalId: randomUUID(),
        title: "Handbook",
        text: `Orbit ${TOKEN} refund policy passage ${randomUUID()}.`,
        mimeType: "text/plain",
        language: "en",
        validFrom: new Date(Date.now() - 2 * HOUR).toISOString(),
      });
      return row.id;
    });
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("keeps a project without a share fully isolated", async () => {
    expect((await search(c1)).passages).toEqual([]);
  });

  it("refuses shares across organizations and to anyone but the owners", async () => {
    const foreign = await call("POST", `/api/organizations/${ws}/knowledge-shares`, owner, {
      libraryProjectId: library,
      consumerProjectId: d1,
    });
    expect(foreign.statusCode).toBe(404);
    const stranger = await call("POST", `/api/organizations/${ws}/knowledge-shares`, outsider, {
      libraryProjectId: library,
      consumerProjectId: c1,
    });
    expect(stranger.statusCode).toBe(404);
    const notLibrary = await call("POST", `/api/organizations/${ws}/knowledge-shares`, owner, {
      libraryProjectId: c2,
      consumerProjectId: c1,
    });
    expect(notLibrary.json().error.code).toBe("LIBRARY_REQUIRED");
  });

  it("brings shared results, with their origin, only into the consumer and module", async () => {
    const created = await call("POST", `/api/organizations/${ws}/knowledge-shares`, owner, {
      libraryProjectId: library,
      consumerProjectId: c1,
      modules: ["support"],
    });
    expect(created.statusCode).toBe(201);
    shareId = created.json().id;
    const found = await search(c1);
    expect(found.passages).toHaveLength(1);
    expect(found.passages[0]!.origin?.shareId).toBe(shareId);
    expect(found.retrieval.shared).toHaveLength(1);
    expect(await validateSearchResult(scope(ws, c1), found as never)).toBe(true);
    // Another project, another module and the MCP path see nothing.
    expect((await search(c2)).passages).toEqual([]);
    expect((await search(c1, "marketing")).passages).toEqual([]);
    expect((await search(c1, "assistant")).passages).toEqual([]);
    expect((await search(c1, "support", false)).passages).toEqual([]);
    // Row-level security: the share is invisible outside its two projects.
    for (const [w, p] of [[ws, c2], [other, d1]] as const) {
      const rows = await scoped(w, p, (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "KnowledgeShare"`,
      );
      expect(Number(rows[0]!.n)).toBe(0);
    }
    const listed = await call("GET", `/api/projects/${c1}/knowledge-shares`, owner);
    expect(listed.json().items).toMatchObject([{ libraryName: "Company handbook", modules: ["support"] }]);
  });

  it("invalidates results when the share changes or the library source changes", async () => {
    const before = await search(c1);
    expect(before.passages).toHaveLength(1);
    const narrowed = await call("PATCH", `/api/organizations/${ws}/knowledge-shares/${shareId}`, owner, {
      sourceIds: [sourceId],
    });
    expect(narrowed.json().generation).toBe(2);
    expect(await validateSearchResult(scope(ws, c1), before as never)).toBe(false);
    const after = await search(c1);
    expect(after.passages).toHaveLength(1);
    expect(await validateSearchResult(scope(ws, c1), after as never)).toBe(true);
    // The library revokes its source: the consumer's result stops being valid.
    await scoped(ws, library, async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id: sourceId } });
      await tx.entity.update({
        where: { id: sourceId },
        data: { data: { ...(row.data as object), status: "revoked", generation: 2 } as Prisma.InputJsonObject },
      });
    });
    expect(await validateSearchResult(scope(ws, c1), after as never)).toBe(false);
    expect((await search(c1)).passages).toEqual([]);
  });

  it("ends the share at once when it is revoked", async () => {
    expect((await call("DELETE", `/api/organizations/${ws}/knowledge-shares/${shareId}`, owner)).statusCode).toBe(204);
    expect((await call("GET", `/api/projects/${c1}/knowledge-shares`, owner)).json().items).toEqual([]);
    const audit = await authDb.systemAuditEvent.findMany({ where: { targetId: shareId } });
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["knowledge_share.created", "knowledge_share.updated", "knowledge_share.revoked"]),
    );
  });
});
