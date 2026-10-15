import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { create } from "../../../shared.ts";
import { assetTools } from "./asset-tools.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * The built-in EDS logo is read from packages/creative relative to this
 * module's file (WP2.1e moved it two folders deeper).
 */
describe.skipIf(!enabled)("asset tools: built-in logo", () => {
  let scope: Scope;
  const users: string[] = [];
  const workspaces: string[] = [];
  beforeAll(async () => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic asset owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic asset tools",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic asset project" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("returns the approved built-in logo as SVG bytes", async () => {
    const row = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      create(tx, scope, "assets", {
        name: "EDS Labs logo",
        type: "original_logo",
        usageApproved: true,
        assetStatus: "approved",
      }),
    );
    const { content } = await assetTools.get(scope, row.id);
    expect(content.mime).toBe("image/svg+xml");
    expect(content.bytes.toString("utf8")).toContain("<svg");
  });
});
