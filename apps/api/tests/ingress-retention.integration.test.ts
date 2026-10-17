import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { create } from "../src/shared.ts";
import { registerModules } from "../src/modules/registry.ts";
import { retention } from "../src/platform/governance/retention.ts";
import { ingressCleanup } from "../src/platform/http/ingress-retention.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerModules();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Public ingress keeps its rows only as long as needed (WP4.2 follow-up):
 * expired public sessions and webhooks older than 30 days are deleted by the
 * hourly cleanup and by the project's retention action, in that project only.
 */
describe.skipIf(!enabled)("public ingress retention", () => {
  const workspaces: string[] = [];
  let scope: Scope;
  let other: Scope;
  const run = <T>(fn: (tx: DbTx) => Promise<T>, s = scope) =>
    scoped(s.workspaceId, s.projectId, fn);
  const project = async () => {
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic ingress retention" },
    });
    workspaces.push(workspace.id);
    const row = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic ingress retention" },
    });
    return {
      workspaceId: workspace.id,
      projectId: row.id,
      userId: "owner-setup",
      role: "owner" as const,
    };
  };
  /** One row of `kind`, created `ageMs` ago. */
  const row = (s: Scope, kind: string, ageMs: number) =>
    run(async (tx) => {
      const created = await create(tx, s, kind, { synthetic: true });
      await tx.entity.update({
        where: { id: created.id },
        data: { createdAt: new Date(Date.now() - ageMs) },
      });
      return created.id;
    }, s);
  const ids = (kind: string, s = scope) =>
    run(
      async (tx) =>
        (
          await tx.entity.findMany({
            where: { kind },
            select: { id: true },
          })
        ).map((r) => r.id),
      s,
    );

  beforeAll(async () => {
    scope = await project();
    other = await project();
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("deletes expired sessions and old webhooks hourly, in their project only", async () => {
    const fresh = await row(scope, "public_sessions", HOUR);
    const expired = await row(scope, "public_sessions", 14 * HOUR);
    const recent = await row(scope, "inbound_webhooks", 29 * DAY);
    const old = await row(scope, "inbound_webhooks", 31 * DAY);
    const foreign = await row(other, "public_sessions", 14 * HOUR);

    await ingressCleanup.run(scope);
    expect(await ids("public_sessions")).toEqual([fresh]);
    expect(await ids("inbound_webhooks")).toEqual([recent]);
    expect(await ids("public_sessions", other)).toEqual([foreign]);
    // The versions go with their rows.
    const versions = await run((tx) =>
      tx.entityVersion.count({ where: { entityId: { in: [expired, old] } } }),
    );
    expect(versions).toBe(0);

    // At most once an hour per project.
    const later = await row(scope, "public_sessions", 14 * HOUR);
    await ingressCleanup.run(scope);
    expect(await ids("public_sessions")).toContain(later);
  });

  it("is part of the project's retention action and its audit", async () => {
    const expired = await row(other, "public_sessions", 20 * HOUR);
    const old = await row(other, "inbound_webhooks", 40 * DAY);
    const result = await run(
      (tx) => retention(tx, { ...other, userId: "owner" }, 365),
      other,
    );
    expect(result).toMatchObject({
      purgedPublicSessions: 2,
      purgedInboundWebhooks: 1,
    });
    expect(await ids("public_sessions", other)).not.toContain(expired);
    expect(await ids("inbound_webhooks", other)).not.toContain(old);
    const [entry] = await run(
      (tx) => tx.auditEvent.findMany({ where: { action: "retention.apply" } }),
      other,
    );
    expect(entry!.metadata).toMatchObject({
      publicSessions: 2,
      inboundWebhooks: 1,
    });
  });
});
