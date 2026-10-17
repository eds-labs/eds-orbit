import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create } from "../src/shared.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const DAY = 86400000;

/**
 * Characterization (WP1.8): what the project export leaves out and what the
 * retention action purges, audits and returns. WP1.8 turns both into
 * platform operations with module contributions; these results must not
 * change. Pause is pinned by the chat-pause, paused-posts, telegram and
 * agent-notifications suites.
 */
describe.skipIf(!enabled)(
  "Project export and retention (characterization)",
  () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let scope: Scope;
    let cookie = "";
    const users: string[] = [];
    const workspaces: string[] = [];
    const origin = process.env.APP_ORIGIN!;
    const ip = () =>
      `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
    const call = (method: "GET" | "POST", url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
        ...(payload ? { payload } : {}),
      });
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, fn);

    beforeAll(async () => {
      app = await buildServer();
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: "Synthetic operations owner", password },
      });
      users.push(created.user.id);
      const workspace = await authDb.workspace.create({
        data: {
          name: "Synthetic project operations",
          members: { create: { userId: created.user.id, role: "owner" } },
        },
      });
      workspaces.push(workspace.id);
      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: { email, password },
      });
      expect(signIn.statusCode).toBe(200);
      const set = signIn.headers["set-cookie"];
      cookie = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
      const project = await call("POST", "/api/projects", {
        name: "Synthetic operations",
        workspaceId: workspace.id,
      });
      expect(project.statusCode).toBe(201);
      scope = {
        workspaceId: workspace.id,
        projectId: project.json().id,
        userId: created.user.id,
        role: "owner",
      };
    });
    afterAll(async () => {
      await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
      await app?.close();
      await closeDatabase();
    });

    it("exports every entity kind except credentials, OAuth state and evidence", async () => {
      await run(async (tx) => {
        for (const kind of [
          "connectors",
          "telegram_connections",
          "drive_connection",
          "drive_oauth_state",
          "evidence",
          "missions",
          "facts",
          "insights",
          "policies",
        ])
          await create(tx, scope, kind, { label: `export-${kind}` });
      });
      const response = await call(
        "GET",
        `/api/projects/${scope.projectId}/export`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Object.keys(body)).toEqual([
        "formatVersion",
        "exportedAt",
        "entities",
      ]);
      expect(body.formatVersion).toBe(1);
      const kinds = [
        ...new Set(
          (body.entities as Array<{ kind: string; data: { label?: string } }>)
            .filter((e) => e.data.label?.startsWith("export-"))
            .map((e) => e.kind),
        ),
      ].sort();
      expect(kinds).toEqual(["facts", "insights", "missions", "policies"]);
    });

    it("purges expired insights and preferences and audits the counts", async () => {
      const at = Date.now();
      const ids = await run(async (tx) => {
        const make = (kind: string, value: Record<string, unknown>) =>
          create(tx, scope, kind, value).then((row) => row.id);
        const oldInsight = await make("insights", {
          status: "active",
          title: "old",
        });
        const freshInsight = await make("insights", {
          status: "active",
          title: "fresh",
        });
        const deletedInsight = await make("insights", { status: "deleted" });
        const oldPreference = await make("preferences", {
          status: "active",
          validUntil: new Date(at - 60 * DAY).toISOString(),
        });
        const openPreference = await make("preferences", { status: "active" });
        for (const id of [oldInsight, deletedInsight])
          await tx.entity.update({
            where: { id },
            data: { updatedAt: new Date(at - 60 * DAY) },
          });
        return { oldInsight, freshInsight, oldPreference, openPreference };
      });
      const response = await call(
        "POST",
        `/api/projects/${scope.projectId}/actions/retention`,
        { days: 30 },
      );
      expect(response.statusCode).toBe(200);
      // Since the WP4.2 follow-up the platform also purges public ingress
      // rows first; this project has none.
      expect(response.json()).toEqual({
        purgedPublicSessions: 0,
        purgedInboundWebhooks: 0,
        purgedInsights: 1,
        purgedPreferences: 1,
      });
      const after = await run(async (tx) => ({
        statuses: Object.fromEntries(
          await Promise.all(
            Object.entries(ids).map(async ([name, id]) => [
              name,
              (
                (await tx.entity.findUniqueOrThrow({ where: { id } })).data as {
                  status: string;
                }
              ).status,
            ]),
          ),
        ),
        audit: (
          await tx.auditEvent.findMany({
            where: {
              projectId: scope.projectId,
              action: { in: ["retention.apply", "memory.delete"] },
            },
          })
        )
          // One transaction: equal timestamps, so sort by content.
          .map((e) => ({
            action: e.action,
            resource:
              Object.entries(ids).find(([, id]) => id === e.resourceId)?.[0] ??
              (e.resourceId === scope.projectId ? "project" : e.resourceId),
            details: e.metadata,
          }))
          .sort((a, b) =>
            `${a.action}:${a.resource}`.localeCompare(
              `${b.action}:${b.resource}`,
            ),
          ),
      }));
      expect(after).toEqual({
        statuses: {
          oldInsight: "deleted",
          freshInsight: "active",
          oldPreference: "deleted",
          openPreference: "active",
        },
        audit: [
          {
            action: "memory.delete",
            resource: "oldInsight",
            details: { kind: "insights" },
          },
          {
            action: "memory.delete",
            resource: "oldPreference",
            details: { kind: "preferences" },
          },
          {
            action: "retention.apply",
            resource: "project",
            details: {
              days: 30,
              publicSessions: 0,
              inboundWebhooks: 0,
              insights: 1,
              preferences: 1,
            },
          },
        ],
      });
    });
  },
);
