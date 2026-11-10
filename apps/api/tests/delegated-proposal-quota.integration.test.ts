import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { withDelegatedProposalQuota } from "../src/platform/mcp/proposals.ts";

// Delegated MCP work orders count against the same proposal quotas as the
// gateway (ADR 0021 §7.3): read from and recorded as `mcp.proposal` events.
const enabled = Boolean(process.env.TEST_AUTH_DATABASE_URL);

describe.skipIf(!enabled)("delegated proposal quota", () => {
  const key = {
    userId: `quota-user-${randomUUID()}`,
    clientId: `https://quota.test/${randomUUID()}.json`,
    grantId: randomUUID(),
    workspaceId: randomUUID(),
  };
  const events = () =>
    authDb.mcpGrantEvent.count({
      where: { userId: key.userId, clientId: key.clientId, action: "mcp.proposal" },
    });
  afterAll(async () => {
    await authDb.mcpGrantEvent.deleteMany({ where: { userId: key.userId } });
    await closeDatabase();
  });

  it("records created proposals, skips deduplicated retries and refuses over the limit", async () => {
    const limits = { perHour: 2, perDay: 3 };
    let ran = 0;
    const propose = (deduplicated = false) =>
      withDelegatedProposalQuota(
        key,
        "fixture_propose",
        async () => {
          ran++;
          return { output: { deduplicated, actionRequestId: randomUUID() }, cards: [] };
        },
        limits,
      );
    await propose();
    await propose(true);
    expect(await events()).toBe(1);
    await propose();
    expect(await events()).toBe(2);
    // The hourly limit is reached: refused before the tool runs.
    await expect(propose()).rejects.toMatchObject({ message: "PROPOSAL_QUOTA_EXCEEDED" });
    expect(ran).toBe(3);
    // A thrown tool records nothing.
    await expect(
      withDelegatedProposalQuota(key, "fixture_propose", async () => {
        throw new Error("BOOM");
      }, { perHour: 10, perDay: 10 }),
    ).rejects.toThrow("BOOM");
    expect(await events()).toBe(2);
    // The day counts across hours.
    await expect(
      withDelegatedProposalQuota(key, "fixture_propose", async () => ({ output: {}, cards: [] }), {
        perHour: 10,
        perDay: 2,
      }),
    ).rejects.toMatchObject({ message: "PROPOSAL_QUOTA_EXCEEDED" });
  });
});
