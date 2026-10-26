import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authDb, closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { list } from "../src/shared.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import { defaultIssuesSettings } from "../src/modules/issues/settings.ts";
import { ISSUES_INTAKE, signIssuesReport } from "../src/modules/issues/sources/webhook.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const EMAIL = "kunde.weber@example.org";

/**
 * The issue center's HTTP API and webhook intake (WP3.5): reachable only
 * with ORBIT_ISSUES on and the module enabled; viewers read, editors report
 * and triage, owners manage settings and sources. Signed deliveries become
 * redacted reports and their raw body is dropped.
 */
describe.skipIf(!enabled)("issue center routes and intake", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () => `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const call = (who: keyof typeof ids, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/projects/${projectId}${url}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const code = (response: { json(): { error?: { code: string } } }) => response.json().error?.code;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) => scoped(workspaceId, projectId, fn);

  beforeAll(async () => {
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({ body: { email, name: `Synthetic issues ${who}`, password } });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic issues",
        members: { create: [
          { userId: ids.owner, role: "owner" },
          { userId: ids.editor, role: "viewer" },
          { userId: ids.viewer, role: "viewer" },
        ] },
      },
    });
    workspaceId = workspace.id;
    projectId = (await authDb.project.create({ data: { workspaceId, name: "Synthetic issues" } })).id;
    for (const [who, role] of [["editor", "editor"], ["viewer", "viewer"]] as const)
      await authDb.projectMember.create({ data: { workspaceId, projectId, userId: ids[who], role } });
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
    process.env.ORBIT_ISSUES = "true";
    process.env.ORBIT_MODULES = "true";
  });
  afterEach(() => {
    delete process.env.ORBIT_ISSUES;
    delete process.env.ORBIT_MODULES;
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: workspaceId } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("answers 404 until the module is on for the installation and the project", async () => {
    delete process.env.ORBIT_ISSUES;
    const off = await call("owner", "GET", "/issues/overview");
    expect([off.statusCode, code(off)]).toEqual([404, "ISSUES_DISABLED"]);
    process.env.ORBIT_ISSUES = "true";
    expect((await call("owner", "GET", "/issues/overview")).statusCode).toBe(404);
    expect((await call("owner", "PUT", "/modules/issues", { enabled: true })).statusCode).toBe(200);
    const on = await call("viewer", "GET", "/issues/overview");
    expect(on.statusCode).toBe(200);
    expect(on.json().metrics).toMatchObject({ open: 0, critical: 0 });
    expect(on.json().leadTimesHours.newToReleased).toBeNull();
  });

  it("lets editors report and triage, viewers read and owners manage the settings", async () => {
    const first = await call("editor", "POST", "/issues/issues", {
      title: "Login button does nothing",
      symptoms: `Customer ${EMAIL} clicks login and nothing happens`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ outcome: "created", method: "new", candidates: 0 });
    const second = await call("editor", "POST", "/issues/issues", { title: "Anmeldung: Login Knopf reagiert nicht" });
    expect(second.json()).toMatchObject({ outcome: "created", candidates: 1 });
    expect((await call("viewer", "POST", "/issues/issues", { title: "x" })).statusCode).toBe(403);
    const detail = await call("viewer", "GET", `/issues/issues/${second.json().issueId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(JSON.stringify(body)).not.toContain(EMAIL);
    expect(body.duplicateCandidates).toHaveLength(1);
    expect(body.duplicateCandidates[0].issue.id).toBe(first.json().issueId);
    // Triage: viewers may not; editors move the status.
    const status = { status: "confirmed", expectedVersion: body.issue.version };
    expect((await call("viewer", "POST", `/issues/issues/${body.issue.id}/status`, status)).statusCode).toBe(403);
    const confirmed = await call("editor", "POST", `/issues/issues/${body.issue.id}/status`, status);
    expect(confirmed.json()).toMatchObject({ status: "confirmed" });
    // Rejecting the candidate keeps both issues.
    const rejected = await call("editor", "POST", `/issues/duplicates/${body.duplicateCandidates[0].id}/reject`);
    expect(rejected.json()).toMatchObject({ status: "rejected" });
    const settings = await call("editor", "GET", "/issues/settings");
    const update = { settings: { ...defaultIssuesSettings(), intake: { dailyReportCap: 4 } }, version: settings.json().version };
    expect((await call("editor", "PUT", "/issues/settings", update)).statusCode).toBe(403);
    expect((await call("owner", "PUT", "/issues/settings", update)).statusCode).toBe(200);
    const listed = await call("viewer", "GET", "/issues/list?status=all&sort=created");
    expect(listed.json().items).toHaveLength(2);
  });

  it("turns a signed webhook delivery into a redacted report and drops its raw body", async () => {
    const created = await call("owner", "POST", "/issues/sources", { name: "n8n alerts", kind: "n8n" });
    expect(created.statusCode).toBe(200);
    const source = created.json();
    expect(source.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await call("owner", "GET", "/issues/sources")).json().items[0]).not.toHaveProperty("secret");
    expect((await call("editor", "GET", "/issues/sources")).statusCode).toBe(403);
    const deliver = (body: object, options: { secret?: string; timestamp?: number } = {}) => {
      const raw = JSON.stringify(body);
      const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
      return app.inject({
        method: "POST",
        url: source.path,
        headers: {
          "content-type": "application/json",
          "x-orbit-timestamp": timestamp,
          "x-orbit-signature": signIssuesReport(options.secret ?? source.secret, timestamp, raw),
        },
        payload: raw,
      });
    };
    const report = {
      contract: "issues.report.v1",
      id: "alert-1",
      title: "Checkout API returns 500",
      symptoms: `Error for ${EMAIL} from 203.0.113.9`,
      fingerprint: "checkout-500",
      diagnostics: { status: 500, route: "/api/checkout" },
      unknownField: "dropped",
    };
    // The public ingress is off by default.
    expect((await deliver(report)).statusCode).toBe(404);
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    expect((await deliver(report, { secret: "forged-secret-value" })).statusCode).toBe(401);
    expect((await deliver(report, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect((await deliver(report)).statusCode).toBe(200);
    expect((await deliver(report)).statusCode).toBe(409);
    // The intake job turns it into a report.
    const jobs = (await run((tx) => list(tx, { workspaceId, projectId, userId: "worker", role: "owner" }, "jobs"))).filter(
      (row) => (row.data as { topic: string }).topic === ISSUES_INTAKE,
    );
    expect(jobs).toHaveLength(1);
    await registeredJobs().get(ISSUES_INTAKE)!.handler({
      scope: { workspaceId, projectId, userId: "worker", role: "owner" },
      jobId: jobs[0]!.id,
      job: jobs[0]!.data as Record<string, any>,
      executionMode: "test",
    });
    const stored = await run((tx) => tx.issueReport.findFirst({ where: { projectId, sourceKind: "n8n" } }));
    expect(stored).toMatchObject({
      title: "Checkout API returns 500",
      symptoms: "Error for [e-mail removed] from [IP removed]",
      fingerprint: "checkout-500",
      diagnostics: { status: 500, route: "/api/checkout" },
      redaction: { email: 1, ip: 1 },
    });
    const raw = await run(async (tx) => {
      const rows = await tx.entity.findMany({ where: { projectId, kind: "inbound_webhooks" } });
      const versions = await tx.entityVersion.findMany({ where: { projectId, entityId: { in: rows.map((r) => r.id) } } });
      return JSON.stringify([rows, versions]);
    });
    expect(raw).not.toContain(EMAIL);
    expect(raw).not.toContain("unknownField");
    expect(raw).toContain('"status":"processed"');
    // A second alert with the same fingerprint joins the same issue.
    expect((await deliver({ ...report, id: "alert-2" })).statusCode).toBe(200);
    const next = (await run((tx) => list(tx, { workspaceId, projectId, userId: "worker", role: "owner" }, "jobs"))).filter(
      (row) => (row.data as { topic: string; resourceId?: string }).topic === ISSUES_INTAKE && row.id !== jobs[0]!.id,
    );
    await registeredJobs().get(ISSUES_INTAKE)!.handler({
      scope: { workspaceId, projectId, userId: "worker", role: "owner" },
      jobId: next[0]!.id,
      job: next[0]!.data as Record<string, any>,
      executionMode: "test",
    });
    const issue = await run((tx) => tx.issue.findFirst({ where: { projectId, fingerprint: "checkout-500" } }));
    expect(issue).toMatchObject({ reportCount: 2 });
    // The daily cap (4 reports, set above) stops integrations, not members.
    expect((await deliver({ ...report, id: "alert-3", fingerprint: "other" })).statusCode).toBe(200);
    const capped = (await run((tx) => list(tx, { workspaceId, projectId, userId: "worker", role: "owner" }, "jobs"))).filter(
      (row) => (row.data as { topic: string }).topic === ISSUES_INTAKE && ![jobs[0]!.id, next[0]!.id].includes(row.id),
    );
    await registeredJobs().get(ISSUES_INTAKE)!.handler({
      scope: { workspaceId, projectId, userId: "worker", role: "owner" },
      jobId: capped[0]!.id,
      job: capped[0]!.data as Record<string, any>,
      executionMode: "test",
    });
    expect(await run((tx) => tx.auditEvent.count({ where: { projectId, action: "issues.intake.dropped" } }))).toBe(1);
    expect(
      (await call("editor", "POST", "/issues/issues", { title: "Members are never capped" })).json(),
    ).toMatchObject({ outcome: "created" });
    // A disabled source refuses further deliveries.
    expect((await call("owner", "DELETE", `/issues/sources/${source.id}`)).statusCode).toBe(200);
    expect((await deliver({ ...report, id: "alert-4" })).statusCode).toBe(401);
  });
});
