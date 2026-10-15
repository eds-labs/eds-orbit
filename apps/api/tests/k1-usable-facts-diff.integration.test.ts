import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { listUsableFacts } from "../src/modules/marketing/agents/content-packages.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const SQL = readFileSync("scripts/rollout/k1-usable-facts-diff.sql", "utf8");
const DAY = 86400000;

/**
 * The K-1 read-only check (scripts/rollout/k1-usable-facts-diff.sql) on a
 * synthetic project: its "today" side must equal the current usableFact
 * rule, and every full-rule reason must show up on the copy it concerns.
 */
describe.skipIf(!enabled)("K-1 usable facts diff (read-only SQL)", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  /** Runs the script as psql would, with the app role (RLS applies). */
  async function check(scope: Scope) {
    const client = new Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      const results = (await client.query(
        SQL.replaceAll(":'workspace_id'", `'${scope.workspaceId}'`).replaceAll(
          ":'project_id'",
          `'${scope.projectId}'`,
        ),
      )) as unknown as Array<{ command: string; rows: any[] }>;
      // BEGIN, SET, the scope SELECT, the report SELECT, ROLLBACK.
      expect(results.map((r) => r.command)).toEqual([
        "BEGIN",
        "SET",
        "SELECT",
        "SELECT",
        "ROLLBACK",
      ]);
      return results[3]!.rows;
    } finally {
      await client.end();
    }
  }

  it("lists lost, gained and unchanged keys with their reasons", async () => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic K-1 owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic K-1",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic K-1 project" },
    });
    const scope: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    const past = new Date(Date.now() - DAY).toISOString();
    const ids = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const where = {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
      };
      const source = async (overrides: Record<string, unknown>) =>
        (
          await tx.entity.create({
            data: {
              ...where,
              kind: "sources",
              data: {
                name: "Synthetic source",
                status: "active",
                generation: 1,
                publicUse: true,
                modelUse: true,
                authority: "official",
                maxAgeHours: 168,
                ...overrides,
              },
            },
          })
        ).id;
      const sources = {
        ok: await source({}),
        paused: await source({ status: "paused" }),
        newer: await source({ generation: 2 }),
        private: await source({ publicUse: false }),
        generated: await source({ authority: "generated" }),
        embargoed: await source({
          embargoUntil: new Date(Date.now() + DAY).toISOString(),
        }),
      };
      const fact = async (
        key: string,
        sourceId: string,
        overrides: Record<string, unknown> = {},
      ) =>
        (
          await tx.entity.create({
            data: {
              ...where,
              kind: "facts",
              data: {
                key,
                value: "1",
                valueType: "text",
                language: "en",
                sourceId,
                sourceGeneration: 1,
                status: "verified",
                publicUse: true,
                modelUse: true,
                validFrom: past,
                ...overrides,
              },
            },
          })
        ).id;
      return {
        ok: await fact("ok.key", sources.ok),
        paused: await fact("paused.key", sources.paused),
        stale: await fact("stale.key", sources.newer),
        private: await fact("private.key", sources.private),
        generated: await fact("generated.key", sources.generated),
        embargoed: await fact("embargoed.key", sources.embargoed),
        missing: await fact("missing.key", randomUUID()),
        language: await fact("language.key", sources.ok, { language: "de" }),
        market: await fact("market.key", sources.ok, { market: "eu" }),
        conflictKept: await fact("conflict.key", sources.ok, { value: "a" }),
        conflictDropped: await fact("conflict.key", sources.paused, {
          value: "b",
        }),
        draft: await fact("draft.key", sources.ok, { status: "draft" }),
        expired: await fact("expired.key", sources.ok, {
          validUntil: new Date(Date.now() - 1000).toISOString(),
        }),
      };
    });

    const rows = await check(scope);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const reasons = (key: string) =>
      byKey[key].excluded_copies.flatMap(
        (c: { reasons: string[] }) => c.reasons,
      );

    expect(Object.fromEntries(rows.map((r) => [r.key, r.change]))).toEqual({
      "ok.key": "unchanged",
      "paused.key": "lost",
      "stale.key": "lost",
      "private.key": "lost",
      "generated.key": "lost",
      "embargoed.key": "lost",
      "missing.key": "lost",
      "language.key": "lost",
      "market.key": "lost",
      "conflict.key": "gained",
      "draft.key": "unusable_both",
      "expired.key": "unusable_both",
    });
    expect(reasons("paused.key")).toEqual(["source_status:paused"]);
    expect(reasons("stale.key")).toEqual(["fact_source_generation_stale"]);
    expect(reasons("private.key")).toEqual(["source_not_public"]);
    expect(reasons("generated.key")).toEqual(["source_generated"]);
    expect(reasons("embargoed.key")).toEqual(["source_embargoed"]);
    expect(reasons("missing.key")).toEqual(["source_missing"]);
    expect(reasons("language.key")).toEqual(["language_mismatch:de"]);
    expect(reasons("market.key")).toEqual(["market_mismatch:eu"]);
    expect(byKey["conflict.key"]).toMatchObject({
      today_state: "conflict",
      k1_state: "usable",
      k1_value: "a",
    });
    expect(byKey["paused.key"].excluded_copies[0].factId).toBe(ids.paused);

    // The "today" side is exactly what marketing uses now.
    const today = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      listUsableFacts(tx, scope, new Date()),
    );
    expect(
      rows
        .filter((r) => r.today_state === "usable")
        .map((r) => r.key)
        .sort(),
    ).toEqual(today.map((row) => (row.data as { key: string }).key).sort());
  });

  it("leaves the database unchanged and ends in ROLLBACK", () => {
    expect(SQL).toMatch(/^BEGIN TRANSACTION [A-Z ]*READ ONLY;$/m);
    expect(SQL.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(SQL).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|COMMIT)\b/i,
    );
  });
});
