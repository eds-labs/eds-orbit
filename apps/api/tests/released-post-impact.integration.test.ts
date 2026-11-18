import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The live index gate is a switch here: a real live evaluation needs paid
// receipts, which are outside this file's scope. An ingest turns the gate
// invalid, as a manifest change does in production.
const gate = vi.hoisted(() => ({ valid: true }));
vi.mock("../../../packages/knowledge/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/knowledge/src/index.ts")
    >();
  return {
    ...actual,
    validateActiveIndexEvaluation: vi.fn(async () => ({
      valid: gate.valid,
      reasons: gate.valid ? [] : ["INDEX_EVALUATION_CORPUS_CHANGED"],
      indexId: "synthetic-index",
    })),
  };
});
vi.mock("../src/platform/knowledge/engine.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/platform/knowledge/engine.ts")>();
  return {
    ...actual,
    ingest: vi.fn(async (...args: Parameters<typeof actual.ingest>) => {
      const result = await actual.ingest(...args);
      gate.valid = false;
      return result;
    }),
  };
});

import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { buildServer } from "../src/server.ts";
import { makeAuth } from "../src/auth.ts";
import { create, data, entity } from "../src/shared.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { knowledgeMcpTools } from "../src/modules/knowledge/mcp-tools.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const DAY = 86400000;

describe.skipIf(!enabled)("Released posts a knowledge change would block", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const others: Array<Awaited<ReturnType<typeof createPackageProject>>> = [];
  const people = {} as Record<"owner" | "editor", { id: string; cookie: string }>;
  const impact = (role: keyof typeof people, projectId = project.owner.projectId) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/knowledge/release-impact`,
      headers: { origin: process.env.APP_ORIGIN!, cookie: people[role].cookie },
    });
  const run = <T>(
    p: Awaited<ReturnType<typeof createPackageProject>>,
    work: Parameters<typeof scoped<T>>[2],
  ) => scoped(p.owner.workspaceId, p.owner.projectId, work);
  /** A released post (or another publication state) with its content. */
  const post = (
    p: Awaited<ReturnType<typeof createPackageProject>>,
    changes: Record<string, unknown> = {},
    title = "Spring launch",
  ) =>
    run(p, async (tx) => {
      const content = await create(tx, p.owner, "content", {
        type: "social",
        channel: X,
        title,
        body: "Synthetic body text that never leaves the server here.",
        status: "reviewed",
      });
      return create(tx, p.owner, "publications", {
        status: "intent_created",
        contentId: content.id,
        channel: X,
        // Three days ahead: beyond the watch's horizon, still blocked by the gate.
        scheduledAt: new Date(Date.now() + 3 * DAY).toISOString(),
        vetoedAt: null,
        test: false,
        ...changes,
      });
    });

  beforeAll(async () => {
    app = await buildServer();
    const auth = makeAuth();
    for (const role of ["owner", "editor"] as const) {
      const email = `${randomUUID()}@example.invalid`,
        password = randomBytes(24).toString("base64url");
      const user = await auth.api.signUpEmail({
        body: { email, password, name: `Synthetic impact ${role}` },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: process.env.APP_ORIGIN! },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers["set-cookie"];
      people[role] = {
        id: user.user.id,
        cookie: (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; "),
      };
    }
  });
  beforeEach(async () => {
    vi.stubEnv("ORBIT_RELEASED_POST_WATCH", "true");
    project = await createPackageProject({ name: "Synthetic release impact" });
    for (const role of ["owner", "editor"] as const) {
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          userId: people[role].id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: people[role].id,
          role,
        },
      });
    }
    gate.valid = true;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await project.cleanup();
    for (const other of others.splice(0)) await other.cleanup();
  });
  afterAll(async () => {
    await app?.close();
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((u) => u.id) } },
    });
    await closeDatabase();
  });

  it("lists a released future post when the live gate is valid", async () => {
    const released = await post(project);
    // Not released posts: a test post, a post the owner stopped, one blocked
    // already, and one whose slot has passed.
    await post(project, { test: true });
    await post(project, { status: "canceled", vetoedAt: new Date().toISOString() });
    await post(project, { status: "blocked_dependency", reason: "CONTENT_CHANGED" });
    await post(project, { scheduledAt: new Date(Date.now() - 60000).toISOString() });
    const response = await impact("owner");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      gateValid: true,
      count: 1,
      dependents: [
        {
          id: released.id,
          title: "Spring launch",
          slotAt: data(released).scheduledAt,
          timeZone: "Europe/Berlin",
          channels: ["Synthetic X"],
        },
      ],
    });
    // A name only: the post's text never leaves the server.
    expect(response.body).not.toContain("Synthetic body text");
  });

  it("returns count only to a member whose Marketing role is none", async () => {
    await post(project);
    vi.stubEnv("ORBIT_MODULE_ROLES", "true");
    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: project.owner.workspaceId,
        projectId: project.owner.projectId,
        userId: people.editor.id,
        moduleId: "marketing",
        role: "none",
      },
    });
    const response = await impact("editor");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      gateValid: true,
      count: 1,
      dependents: [],
    });
    expect(response.body).not.toContain("Spring launch");
    // The owner keeps the details.
    expect((await impact("owner")).json().dependents).toHaveLength(1);
  });

  it("is empty when the live gate is already invalid", async () => {
    await post(project);
    gate.valid = false;
    const response = await impact("owner");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      gateValid: false,
      count: 0,
      dependents: [],
    });
  });

  it("never lists another project's posts", async () => {
    const own = await post(project);
    const other = await createPackageProject({ name: "Synthetic release impact" });
    others.push(other);
    // Its fixture ingest closed the switch; the first project's gate is valid.
    gate.valid = true;
    await post(other, {}, "Foreign launch");
    await post(other, {}, "Foreign launch");
    const body = (await impact("owner")).json();
    expect(body.count).toBe(1);
    expect(body.dependents.map((d: { id: string }) => d.id)).toEqual([own.id]);
    expect(JSON.stringify(body)).not.toContain("Foreign launch");
    // A non-member of the other project gets nothing from it.
    expect((await impact("owner", other.owner.projectId)).statusCode).toBe(404);
  });

  it("answers enabled false with the flag off", async () => {
    await post(project);
    vi.stubEnv("ORBIT_RELEASED_POST_WATCH", "false");
    const response = await impact("owner");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      gateValid: true,
      count: 0,
      dependents: [],
    });
  });

  describe("knowledge write tools over MCP", () => {
    beforeEach(() => {
      vi.stubEnv("ORBIT_MCP_TASKS", "true");
      vi.stubEnv("ORBIT_MCP_PROPOSALS", "true");
    });
    /** Proposes the operation as the owner's assistant, approves it and returns its result. */
    const approved = async (name: string, args: Record<string, unknown>) => {
      const tool = knowledgeMcpTools.find((t) => t.name === name)!;
      const proposal = await tool.execute(
        {
          scope: moduleScope(project.owner, "knowledge"),
          runId: "synthetic",
          conversationId: "synthetic",
          callIndex: 1,
        },
        { ...args, idempotencyKey: randomUUID() },
      );
      const id = (proposal.output as { actionRequestId: string }).actionRequestId;
      expect(id).toEqual(expect.any(String));
      return run(project, async (tx) => {
        const row = await entity(tx, project.owner, "action_requests", id);
        await decideActionRequest(tx, project.owner, row.id, {
          version: row.version,
          packageHash: data(row).packageHash,
          decision: "approve",
        });
        const done = await entity(tx, project.owner, "action_requests", row.id);
        expect(data(done).status).toBe("consumed");
        return data(done).executionResult;
      });
    };
    const document = (externalId: string) => ({
      sourceId: project.sourceId,
      externalId,
      title: "Synthetic pricing",
      text: "Synthetic pricing text for the release impact test.",
      language: "en",
      mimeType: "text/plain",
    });

    it("knowledge_add_document returns releaseImpact computed before the ingest", async () => {
      const released = await post(project);
      const result = await approved("knowledge_add_document", document("impact-doc"));
      // The ingest ran and turned the gate invalid; the warning was read before.
      expect(gate.valid).toBe(false);
      expect(result.releaseImpact).toEqual({
        enabled: true,
        gateValid: true,
        count: 1,
        dependents: [expect.objectContaining({ id: released.id, title: "Spring launch" })],
      });
    });

    it("knowledge_add_document has no releaseImpact when no released post depends on the gate", async () => {
      const result = await approved("knowledge_add_document", document("quiet-doc"));
      expect(result).not.toHaveProperty("releaseImpact");
    });

    it("knowledge_import_url returns releaseImpact with its queued job", async () => {
      await post(project);
      const result = await approved("knowledge_import_url", {
        sourceId: project.sourceId,
        url: "https://example.invalid/pricing",
        language: "en",
      });
      expect(result.status).toBe("queued");
      expect(result.releaseImpact).toMatchObject({ gateValid: true, count: 1 });
    });
  });
});
