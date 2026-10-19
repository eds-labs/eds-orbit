import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineTool,
  mcpExposureProblem,
  type OrbitTool,
} from "../src/modules/agents/tools/registry.ts";
import {
  listedRequester,
  requestedBy,
} from "../src/modules/action-requests.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { assertMcpToolContracts } from "../src/platform/mcp/adapter.ts";
import {
  MCP_PROPOSAL_DAY_CACHE_MAX,
  McpRateLimiter,
} from "../src/platform/mcp/limits.ts";
import {
  mcpProposalArgsHash,
  mcpProposalOrigin,
  McpProposalDayCache,
  mcpRequester,
  reserveProposal,
  type ProposalQuota,
} from "../src/platform/mcp/proposals.ts";
import { publicEntity } from "../src/platform/shared.ts";
import { tasksModule } from "./fixtures/modules/tasks/manifest.ts";
import { PROJECT_WRITE } from "../src/platform/tenancy/permissions.ts";

// Track M WP-M5, Task 4 (D-M5-8): the proposal controls that need no
// database. The gateway-level tests are in mcp-proposal-controls and
// mcp-proposal-owner-controls.

const HOUR = 3_600_000;
const proposer = (over: Partial<Record<string, string>> = {}) => ({
  userId: "user-1",
  clientId: "https://client.test/a.json",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ...over,
});

/** A quota with an injected clock and daily counter, as the gateway builds it. */
function quotaWith(options: {
  now: () => number;
  countToday?: (
    key: ReturnType<typeof proposer>,
    since: Date,
  ) => Promise<number>;
  perHour?: number;
  perDay?: number;
  usedUp?: McpProposalDayCache;
}): ProposalQuota {
  return {
    limiter: new McpRateLimiter(options.now),
    perHour: options.perHour ?? 2,
    perDay: options.perDay ?? 3,
    now: options.now,
    usedUp: options.usedUp ?? new McpProposalDayCache(),
    countToday: options.countToday ?? (async () => 0),
  };
}

const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Error) => error.message,
  );

describe("proposal quotas key on user, client and workspace (D-M5-8)", () => {
  it("keeps the hourly bucket across grants of the same user, client and workspace", async () => {
    const now = () => Date.UTC(2026, 9, 19, 10);
    const quota = quotaWith({ now });
    // Two creations under two grant ids (a re-selection in between).
    await reserveProposal(quota, proposer());
    await reserveProposal(quota, proposer());
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
    // Another client, user or workspace has its own bucket.
    for (const other of [
      proposer({ clientId: "https://client.test/b.json" }),
      proposer({ userId: "user-2" }),
      proposer({ workspaceId: "22222222-2222-4222-8222-222222222222" }),
    ])
      expect(await refusal(reserveProposal(quota, other))).toBeNull();
  });

  it("counts the day for the key, not for a grant", async () => {
    const asked: unknown[] = [];
    const quota = quotaWith({
      now: () => Date.UTC(2026, 9, 19, 10),
      countToday: async (key, since) => {
        asked.push({ key, since: since.toISOString() });
        return 0;
      },
    });
    await reserveProposal(quota, proposer());
    expect(asked).toEqual([
      { key: proposer(), since: "2026-10-19T00:00:00.000Z" },
    ]);
  });
});

describe("hourly bucket charged before the call (D-M5-8, review M4)", () => {
  it("lets concurrent calls of one key take only the free room", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const quota = quotaWith({
      now: () => Date.UTC(2026, 9, 19, 10),
      perHour: 2,
      perDay: 100,
      countToday: async () => {
        await gate;
        return 0;
      },
    });
    const calls = Array.from({ length: 5 }, () =>
      refusal(reserveProposal(quota, proposer())),
    );
    open();
    const outcomes = await Promise.all(calls);
    expect(outcomes.filter((o) => o === null)).toHaveLength(2);
    expect(
      outcomes.filter((o) => o === "PROPOSAL_QUOTA_EXCEEDED"),
    ).toHaveLength(3);
  });

  it("gives the room back on release, once, and never to a later window", async () => {
    let now = Date.UTC(2026, 9, 19, 10);
    const quota = quotaWith({ now: () => now, perHour: 1, perDay: 100 });
    const first = await reserveProposal(quota, proposer());
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
    // A deduplicated or failed call: released, and a second release is a no-op.
    first.release();
    first.release();
    const second = await reserveProposal(quota, proposer());
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
    // The window rolled over and a new reservation took the new one: the
    // old reservation's release must not free it.
    now += HOUR + 1;
    await reserveProposal(quota, proposer());
    second.release();
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
  });

  it("a refusal of the daily quota or a failed count uses no hourly room", async () => {
    let stored = 100;
    let fail = false;
    const quota = quotaWith({
      now: () => Date.UTC(2026, 9, 19, 10),
      perHour: 1,
      perDay: 100,
      countToday: async () => {
        if (fail) throw new Error("count failed");
        return stored;
      },
    });
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
    // Forget the cached day: the hourly room of 1 is still free.
    quota.usedUp = new McpProposalDayCache();
    stored = 0;
    expect(await refusal(reserveProposal(quota, proposer()))).toBeNull();
    // A count that throws gives the room back too.
    fail = true;
    const other = proposer({ userId: "user-3" });
    expect(await refusal(reserveProposal(quota, other))).toBe("count failed");
    fail = false;
    stored = 0;
    expect(await refusal(reserveProposal(quota, other))).toBeNull();
  });
});

describe("daily 'used up' cache (D-M5-8)", () => {
  it("stops counting once the day is used up and counts again after UTC midnight", async () => {
    let now = Date.UTC(2026, 9, 19, 22);
    let counted = 0;
    let stored = 3;
    const quota = quotaWith({
      now: () => now,
      countToday: async () => {
        counted += 1;
        return stored;
      },
    });
    expect(await refusal(reserveProposal(quota, proposer()))).toBe(
      "PROPOSAL_QUOTA_EXCEEDED",
    );
    expect(counted).toBe(1);
    // Refused again without a count, until the day ends.
    now += HOUR;
    for (let i = 0; i < 5; i += 1)
      expect(await refusal(reserveProposal(quota, proposer()))).toBe(
        "PROPOSAL_QUOTA_EXCEEDED",
      );
    expect(counted).toBe(1);
    // Another key is unaffected and is counted.
    expect(
      await refusal(reserveProposal(quota, proposer({ userId: "user-2" }))),
    ).toBe("PROPOSAL_QUOTA_EXCEEDED");
    expect(counted).toBe(2);
    // The next UTC day: counted again, and allowed with fewer events.
    now = Date.UTC(2026, 9, 20, 0, 0, 1);
    stored = 0;
    expect(await refusal(reserveProposal(quota, proposer()))).toBeNull();
    expect(counted).toBe(3);
  });

  it("does not cache a day that still has room", async () => {
    let counted = 0;
    const quota = quotaWith({
      now: () => Date.UTC(2026, 9, 19, 10),
      countToday: async () => {
        counted += 1;
        return 2;
      },
    });
    await reserveProposal(quota, proposer());
    await reserveProposal(quota, proposer());
    expect(counted).toBe(2);
  });

  it("is bounded: expired entries go first, then the oldest", () => {
    expect(MCP_PROPOSAL_DAY_CACHE_MAX).toBe(10_000);
    const cache = new McpProposalDayCache(2);
    const t = Date.UTC(2026, 9, 19, 10);
    cache.add("a", t + HOUR, t);
    cache.add("b", t + 2 * HOUR, t);
    expect(cache.size).toBe(2);
    // "a" has expired: it is evicted for "c"; "b" stays.
    cache.add("c", t + 3 * HOUR, t + HOUR + 1);
    expect(cache.has("a", t + HOUR + 1)).toBe(false);
    expect(cache.has("b", t + HOUR + 1)).toBe(true);
    expect(cache.has("c", t + HOUR + 1)).toBe(true);
    // Nothing expired: the oldest goes, the size stays bounded.
    cache.add("d", t + 4 * HOUR, t + HOUR + 2);
    expect(cache.size).toBe(2);
    expect(cache.has("b", t + HOUR + 2)).toBe(false);
    expect(cache.has("d", t + HOUR + 2)).toBe(true);
    // An entry ends at its time.
    expect(cache.has("d", t + 4 * HOUR)).toBe(false);
  });

  it("ends the cached refusal exactly at the next UTC midnight", async () => {
    let now = Date.UTC(2026, 9, 19, 23, 59, 59);
    let counted = 0;
    const quota = quotaWith({
      now: () => now,
      countToday: async () => {
        counted += 1;
        return 3;
      },
    });
    await refusal(reserveProposal(quota, proposer()));
    now = Date.UTC(2026, 9, 20) - 1;
    await refusal(reserveProposal(quota, proposer()));
    expect(counted).toBe(1);
    now = Date.UTC(2026, 9, 20);
    await refusal(reserveProposal(quota, proposer()));
    expect(counted).toBe(2);
  });
});

const proposalOutput = (shape: z.ZodRawShape) => z.object(shape).strict();
const fixtureTool = (outputSchema: z.ZodType, risk = "P_proposal"): OrbitTool =>
  ({
    name: "suggest_fixture",
    namespace: "tasks",
    description: "A fixture proposal tool.",
    parameters: z.object({ title: z.string() }).strict(),
    risk,
    permission: PROJECT_WRITE,
    deferLoading: false,
    exposure: { assistant: false, mcp: true },
    outputSchema,
    async execute() {
      return { output: {}, cards: [] };
    },
  }) as OrbitTool;

describe("proposal tool contract at startup (D-M5-8)", () => {
  afterEach(() => {
    registerTestModules([]);
  });

  const lacking = [
    proposalOutput({ actionRequestId: z.string() }),
    proposalOutput({
      actionRequestId: z.string(),
      deduplicated: z.boolean().optional(),
    }),
    proposalOutput({
      actionRequestId: z.string(),
      deduplicated: z.boolean().nullable(),
    }),
    proposalOutput({ actionRequestId: z.string(), deduplicated: z.string() }),
    proposalOutput({ deduplicated: z.boolean() }),
  ];

  it("refuses an MCP proposal tool without a required boolean deduplicated and an actionRequestId", () => {
    for (const schema of lacking) {
      const tool = fixtureTool(schema);
      expect(mcpExposureProblem(tool)).toBe(
        "tool suggest_fixture is a proposal tool exposed to MCP whose output schema lacks a required boolean deduplicated or a string actionRequestId",
      );
      expect(() => defineTool(tool)).toThrow(
        "TOOL_PROPOSAL_OUTPUT_INVALID:suggest_fixture",
      );
      expect(() => assertMcpToolContracts([tool])).toThrow(
        /^MCP_TOOL_CONTRACT_INVALID: tool suggest_fixture/,
      );
    }
  });

  it("fails module registration, so the gateway never starts with such a tool", () => {
    registerTestModules([
      {
        module: tasksModule,
        contributions: { tools: [fixtureTool(lacking[0]!)] },
      },
    ]);
    expect(() => registerModules()).toThrow(
      /MODULE_CONTRIBUTIONS_INVALID: .*suggest_fixture is a proposal tool/,
    );
  });

  it("accepts the contract, and asks nothing of read tools", () => {
    const good = fixtureTool(
      proposalOutput({
        actionRequestId: z.string(),
        deduplicated: z.boolean(),
      }),
    );
    expect(mcpExposureProblem(good)).toBeUndefined();
    expect(() => defineTool(good)).not.toThrow();
    expect(() => assertMcpToolContracts([good])).not.toThrow();
    const read = fixtureTool(proposalOutput({ total: z.number() }), "R0_read");
    expect(mcpExposureProblem(read)).toBeUndefined();
  });

  it("holds for every proposal tool Orbit registers", async () => {
    registerModules();
    const { registeredTools } =
      await import("../src/platform/modules/contributions.ts");
    expect(() => assertMcpToolContracts(registeredTools())).not.toThrow();
  });
});

describe("requester derived centrally from the channel (D-M5-8)", () => {
  const scope = {
    workspaceId: proposer().workspaceId,
    projectId: "33333333-3333-4333-8333-333333333333",
    userId: "user-1",
    role: "editor" as const,
  };
  const channel = {
    kind: "mcp" as const,
    clientId: "https://client.test/a.json",
    grantId: "44444444-4444-4444-8444-444444444444",
    requestId: "req-1",
  };

  it("names the user, client, grant and run of the call", () => {
    expect(
      mcpProposalOrigin({ scope, runId: "run-1", channel }, "tool_x"),
    ).toEqual({
      tool: "tool_x",
      userId: "user-1",
      clientId: channel.clientId,
      grantId: channel.grantId,
      agentRunId: "run-1",
    });
    // Without an AgentRun the gateway passes its request id as the run id.
    expect(
      mcpProposalOrigin({ scope, runId: "req-1", channel }, "tool_x")
        .agentRunId,
    ).toBeNull();
  });

  it("refuses a call without a complete MCP channel", () => {
    for (const bad of [
      undefined,
      { ...channel, clientId: "" },
      { ...channel, grantId: "" },
      { ...channel, requestId: "" },
      { ...channel, kind: "chat" },
    ])
      expect(() =>
        mcpProposalOrigin(
          { scope, runId: "run-1", channel: bad as typeof channel },
          "tool_x",
        ),
      ).toThrow(expect.objectContaining({ code: "MCP_CHANNEL_INCOMPLETE" }));
    expect(() =>
      mcpProposalOrigin(
        { scope: { ...scope, userId: "" }, runId: "run-1", channel },
        "tool_x",
      ),
    ).toThrow(expect.objectContaining({ code: "MCP_CHANNEL_INCOMPLETE" }));
  });

  it("builds the stored requester with the hash of the normalized arguments", () => {
    const origin = mcpProposalOrigin({ scope, runId: "run-1", channel }, "t");
    const args = { name: "x", channels: ["a"] };
    const built = mcpRequester(origin, scope.projectId, args);
    expect(built).toEqual({
      kind: "mcp",
      userId: "user-1",
      clientId: channel.clientId,
      grantId: channel.grantId,
      agentRunId: "run-1",
      argsHash: mcpProposalArgsHash("t", scope.projectId, args),
    });
    expect(requestedBy.parse(built)).toEqual(built);
  });
});

describe("project export requester (review M3)", () => {
  it("trims the MCP requester of an exported action request, nothing else", () => {
    const row = {
      id: "r",
      kind: "action_requests",
      data: {
        status: "pending",
        payload: { name: "x" },
        requestedBy: {
          kind: "mcp",
          userId: "u",
          clientId: "https://client.test/a.json",
          grantId: "g",
          agentRunId: "run",
          argsHash: "a".repeat(64),
        },
      },
    };
    expect(publicEntity(row)).toEqual({
      ...row,
      data: {
        ...row.data,
        requestedBy: {
          kind: "mcp",
          userId: "u",
          clientId: "https://client.test/a.json",
        },
      },
    });
    const user = {
      id: "s",
      kind: "action_requests",
      data: { requestedBy: { kind: "user", userId: "u" } },
    };
    expect(publicEntity(user)).toEqual(user);
  });
});

describe("inbox list requester (D-M5-8)", () => {
  it("trims an MCP requester to kind, user and client", () => {
    expect(
      listedRequester({
        kind: "mcp",
        userId: "u",
        clientId: "https://client.test/a.json",
        grantId: "g",
        agentRunId: "r",
        argsHash: "a".repeat(64),
      }),
    ).toEqual({
      kind: "mcp",
      userId: "u",
      clientId: "https://client.test/a.json",
    });
  });

  it("leaves other requesters as stored", () => {
    expect(listedRequester({ kind: "user", userId: "u" })).toEqual({
      kind: "user",
      userId: "u",
    });
    expect(
      listedRequester({ kind: "agent", userId: "u", agentRunId: null }),
    ).toEqual({ kind: "agent", userId: "u", agentRunId: null });
  });
});
