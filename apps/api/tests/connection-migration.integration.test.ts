import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { connectionAccess } from "../src/platform/connections/connections.ts";
import {
  applyConsolidation,
  connectionInventory,
  planConsolidation,
  rollbackConsolidation,
} from "../src/platform/connections/migration.ts";
import { encrypt } from "../src/platform/shared.ts";

// Migration of project connections to one organization connection (ADR
// 0013, WP3.5): fingerprints find shared keys without printing them, only
// projects with the same key are bound, never across organizations, and a
// rollback restores every project's own key.

const enabled = Boolean(process.env.TEST_DATABASE_URL);
Object.assign(process.env, {
  ORBIT_CONNECTIONS: "true",
  ORBIT_CONNECTIONS_CUTOVER: "postiz",
});

describe.skipIf(!enabled)("Connection migration (ADR 0014)", () => {
  const SHARED = `shared-${randomBytes(10).toString("hex")}`;
  const OTHER = `other-${randomBytes(10).toString("hex")}`;
  let ws: string, foreignWs: string;
  const projects: Record<string, string> = {};
  const connectors: Record<string, string> = {};
  let connectionId: string;

  async function connector(name: string, workspaceId: string, key: string) {
    const projectId = projects[name]!;
    connectors[name] = (
      await scoped(workspaceId, projectId, (tx) =>
        tx.entity.create({
          data: {
            workspaceId,
            projectId,
            kind: "connectors",
            data: {
              provider: "postiz",
              baseUrl: "https://postiz.example.invalid/api/public/v1",
              status: "write_verified",
              encryptedCredential: encrypt(key, process.env.CREDENTIAL_KEY!),
            },
          },
        }),
      )
    ).id;
  }
  const access = (name: string, workspaceId = ws) =>
    scoped(workspaceId, projects[name]!, async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id: connectors[name] } });
      return connectionAccess(tx, { workspaceId, projectId: projects[name]! }, row.data as Record<string, unknown>);
    });

  beforeAll(async () => {
    const w = await authDb.workspace.create({
      data: { name: "Synthetic migration", projects: { create: [{ name: "A" }, { name: "B" }, { name: "C" }] } },
      include: { projects: true },
    });
    const f = await authDb.workspace.create({
      data: { name: "Synthetic migration foreign", projects: { create: [{ name: "F" }] } },
      include: { projects: true },
    });
    ws = w.id;
    foreignWs = f.id;
    for (const p of [...w.projects, ...f.projects]) projects[p.name] = p.id;
    await connector("A", ws, SHARED);
    await connector("B", ws, SHARED);
    await connector("C", ws, OTHER);
    await connector("F", foreignWs, SHARED);
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: [ws, foreignWs] } } });
    await closeDatabase();
  });

  it("finds projects sharing a key without printing any key", async () => {
    const inventory = await connectionInventory({ workspaceId: ws });
    expect(JSON.stringify(inventory)).not.toContain(SHARED);
    expect(JSON.stringify(inventory)).not.toContain(OTHER);
    expect(inventory.candidates).toHaveLength(1);
    expect(inventory.candidates[0]!.projects.map((p) => p.projectId).sort()).toEqual(
      [projects.A, projects.B].sort(),
    );
  });

  it("binds only projects of the same organization with the same key", async () => {
    const plan = await planConsolidation({ workspaceId: ws, provider: "postiz", sourceConnectorId: connectors.A! });
    expect(plan.bind.map((b) => b.projectId).sort()).toEqual([projects.A, projects.B].sort());
    expect(plan.skipped).toEqual([{ projectId: projects.C, connectorId: connectors.C, reason: "different_key" }]);
    await expect(
      planConsolidation({ workspaceId: ws, provider: "postiz", sourceConnectorId: connectors.F! }),
    ).rejects.toMatchObject({ code: "SOURCE_CONNECTION_NOT_FOUND" });
    const applied = await applyConsolidation(plan, "Company Postiz");
    connectionId = applied.connectionId;
    expect(applied.bound).toBe(2);
    const stored = await authDb.connectionSecret.findFirstOrThrow({ where: { connectionId } });
    expect(stored.ciphertext).not.toContain(SHARED);
    expect((await access("A")).credential).toBe(SHARED);
    expect((await access("B")).credential).toBe(SHARED);
    expect((await access("C")).credential).toBe(OTHER);
    // The foreign organization's project is untouched.
    expect((await access("F", foreignWs)).credential).toBe(SHARED);
    expect(await authDb.connectionGrant.count({ where: { connectionId, workspaceId: foreignWs } })).toBe(0);
  });

  it("rolls back to every project's own key", async () => {
    const result = await rollbackConsolidation(connectionId);
    expect(result).toEqual({ unbound: 2, keyless: [] });
    expect(await authDb.connectionGrant.count({ where: { connectionId, revokedAt: null } })).toBe(0);
    for (const name of ["A", "B"]) {
      const row = await scoped(ws, projects[name]!, (tx) =>
        tx.entity.findFirstOrThrow({ where: { id: connectors[name] } }),
      );
      expect((row.data as Record<string, unknown>).centralConnectionId).toBeUndefined();
      expect((await access(name)).credential).toBe(SHARED);
    }
  });
});
