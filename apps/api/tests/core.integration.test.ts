import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  type PrismaClient,
} from "../../../packages/db/src/index.ts";
import { create, update, data, hash } from "../src/shared.ts";
import { reserve, settle } from "../src/modules/budget.ts";
import { preflight, approve, checkClaims } from "../src/modules/policy.ts";
import { resolveChannelRules } from "../src/modules/channel-rules.ts";
import {
  publishIntent,
  claimPublication,
  finishPublication,
  deterministicDraft,
  reviewContent,
  analyze,
} from "../src/modules/workflow.ts";
import {
  ingest,
  retrieve,
  setFact,
  revokeSource,
} from "../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)("Real PostgreSQL marketing control plane", () => {
  let db: PrismaClient, auth: PrismaClient, scope: Scope, sourceId: string;
  const now = new Date(),
    past = new Date(now.valueOf() - 86400000).toISOString(),
    future = new Date(now.valueOf() + 30 * 86400000).toISOString();
  const policy = {
    mode: "autopilot",
    channels: ["test-social"],
    contentTypes: ["social"],
    allowedOrigins: ["https://example.org"],
    startAt: past,
    endAt: future,
    maxPerDay: 3,
    minIntervalMinutes: 1,
    dailyBudgetMicros: 100,
    monthlyBudgetMicros: 200,
    perRunBudgetMicros: 100,
    approvedPaidTests: true,
  };
  const run = <T>(fn: (tx: any) => Promise<T>) =>
    scoped(scope.workspaceId, scope.projectId, fn, db);
  beforeEach(async () => {
    db = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic owner",
        email: randomUUID() + "@example.invalid",
      },
    });
    const w = await auth.workspace.create({
      data: {
        name: "Synthetic integration",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const p = await auth.project.create({
      data: {
        workspaceId: w.id,
        name: "Control tests",
        timezone: "Europe/Berlin",
        mode: "autopilot",
      },
    });
    scope = {
      workspaceId: w.id,
      projectId: p.id,
      userId: user.id,
      role: "owner",
    };
    sourceId = await run(
      async (tx) =>
        (
          await create(tx, scope, "sources", {
            name: "Approved synthetic guide",
            type: "manual",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: false,
            authority: "official",
            maxAgeHours: 168,
            allowedOrigins: [],
            allowedPaths: ["/"],
          })
        ).id,
    );
    await run((tx) =>
      ingest(tx, scope, {
        sourceId,
        externalId: "guide",
        title: "Orbit fixture",
        text: "Orbit supports a confirmed multilingual calendar for approved campaigns.",
        mimeType: "text/plain",
        language: "en",
        expectedGeneration: 1,
      }),
    );
    await run((tx) =>
      setFact(tx, scope, {
        key: "price",
        value: "19",
        valueType: "decimal",
        currency: "EUR",
        language: "en",
        sourceId,
        validFrom: past,
        validUntil: future,
        status: "verified",
        publicUse: true,
        modelUse: false,
      }),
    );
    await run((tx) =>
      create(tx, scope, "policies", { ...policy, active: true }),
    );
  });
  afterEach(async () => {
    if (auth && scope) {
      await auth.workspace.delete({ where: { id: scope.workspaceId } });
      await auth.user.delete({ where: { id: scope.userId } });
    }
    await db?.$disconnect();
    await auth?.$disconnect();
  });
  async function draft() {
    return run(async (tx) => {
      const mission = await create(tx, scope, "missions", {
        title: "Verified price",
        goal: "price",
        audience: "Synthetic",
        language: "en",
        channels: ["test-social"],
        startAt: past,
        endAt: future,
        maxContents: 1,
        targetAction: "Learn more.",
        sourceIds: [sourceId],
        contentType: "social",
        status: "ready",
      });
      const [c] = await deterministicDraft(tx, scope, mission.id);
      return reviewContent(tx, scope, c.id, c.version);
    });
  }
  it("A04/A07/A26: mission yields evidence, reviewed claims and test publication", async () => {
    const c = await draft();
    expect(data(c).status).toBe("reviewed");
    const intent = await run((tx) =>
      publishIntent(tx, scope, { contentId: c.id, version: c.version }),
    );
    const sending = await run((tx) => claimPublication(tx, scope, intent.id));
    expect(sending.send).toBe(true);
    const done = await run((tx) =>
      finishPublication(tx, scope, intent.id, data(sending.pub).fence, {
        status: "published_test",
        remoteId: "synthetic",
      }),
    );
    expect(data(done).status).toBe("published_test");
    const duplicate = await run((tx) => claimPublication(tx, scope, intent.id));
    expect(duplicate.send).toBe(false);
  });
  it("A08: Observe blocks live write independently of content prompt", async () => {
    const c = await draft();
    await run(async (tx) => {
      const policies = await tx.entity.findMany({
        where: { projectId: scope.projectId, kind: "policies" },
      });
      await update(tx, scope, policies[0], {
        ...policy,
        active: true,
        mode: "observe",
      });
    });
    const p = await run((tx) => preflight(tx, scope, c.id, { test: false }));
    expect(p.blockers).toContain("OBSERVE_FORBIDS_EXTERNAL_WRITE");
  });
  it.each([
    ["x", 280, 281, 280],
    ["telegram", 4096, 4097, 4096],
    ["linkedin", 3000, 3001, 3000],
  ] as const)(
    "%s uses its assigned provider limit in claim review and preflight",
    async (identifier, limit, tooLong, expectedLimit) => {
      const content = await draft();
      await run((tx) =>
        create(tx, scope, "connectors", {
          provider: "postiz",
          status: "read_verified",
          channels: [
            {
              id: "test-social",
              name: "Display name is not the provider",
              identifier,
            },
          ],
          assignedIntegrationIds: ["test-social"],
        }),
      );
      const rules = await run((tx) =>
        resolveChannelRules(tx, scope, "test-social", "social", false),
      );
      expect(rules).toMatchObject({
        providerIdentifier: identifier,
        characterLimit: expectedLimit,
        liveCapabilityKnown: true,
      });
      const within = await run((tx) =>
        update(tx, scope, content, {
          ...data(content),
          body: "a".repeat(limit),
        }),
      );
      expect(
        (await run((tx) => checkClaims(tx, scope, within.id))).problems,
      ).not.toContain("CHANNEL_LIMIT_EXCEEDED");
      const long = await run((tx) =>
        update(tx, scope, within, {
          ...data(within),
          body: "a".repeat(tooLong),
        }),
      );
      expect(
        (await run((tx) => checkClaims(tx, scope, long.id))).problems,
      ).toContain("CHANNEL_LIMIT_EXCEEDED");
      expect(
        (await run((tx) => preflight(tx, scope, long.id, { test: true })))
          .blockers,
      ).toContain("CHANNEL_LIMIT_EXCEEDED");
    },
  );
  it("counts the appended URL and weighted X Unicode, and Telegram media captions", async () => {
    const content = await draft();
    await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "postiz",
        status: "read_verified",
        channels: [{ id: "test-social", name: "X", identifier: "x" }],
        assignedIntegrationIds: ["test-social"],
      }),
    );
    const withUrl = await run((tx) =>
      update(tx, scope, content, {
        ...data(content),
        body: "a".repeat(260),
        targetUrl: "https://example.org/learn",
      }),
    );
    expect(
      (await run((tx) => checkClaims(tx, scope, withUrl.id))).problems,
    ).toContain("CHANNEL_LIMIT_EXCEEDED");
    const punctuated = await run((tx) =>
      update(tx, scope, withUrl, {
        ...data(withUrl),
        body: "a".repeat(255) + " https://a.co!!!",
        targetUrl: undefined,
      }),
    );
    expect(
      (await run((tx) => checkClaims(tx, scope, punctuated.id))).problems,
    ).toContain("CHANNEL_LIMIT_EXCEEDED");
    const weighted = await run((tx) =>
      update(tx, scope, punctuated, {
        ...data(punctuated),
        body: "漢".repeat(141),
        targetUrl: undefined,
      }),
    );
    expect(
      (await run((tx) => checkClaims(tx, scope, weighted.id))).problems,
    ).toContain("CHANNEL_LIMIT_EXCEEDED");
    const connector: any = await run((tx) =>
      tx.entity.findFirstOrThrow({
        where: { projectId: scope.projectId, kind: "connectors" },
      }),
    );
    await run((tx) =>
      update(tx, scope, connector, {
        ...data(connector),
        channels: [
          { id: "test-social", name: "Telegram", identifier: "telegram" },
        ],
      }),
    );
    expect(
      (
        await run((tx) =>
          resolveChannelRules(tx, scope, "test-social", "social", true),
        )
      ).characterLimit,
    ).toBe(1024);
    const asset = await run((tx) =>
      create(tx, scope, "assets", {
        name: "Synthetic approved image",
        type: "photo",
        assetStatus: "approved",
        usageApproved: true,
        mime: "image/png",
        base64: "synthetic",
      }),
    );
    const caption = await run((tx) =>
      update(tx, scope, weighted, {
        ...data(weighted),
        body: "a".repeat(1025),
        assetId: asset.id,
      }),
    );
    expect(
      (await run((tx) => preflight(tx, scope, caption.id, { test: true })))
        .blockers,
    ).toContain("CHANNEL_LIMIT_EXCEEDED");
  });
  it("allows unknown-provider drafts but fails closed for live handoff", async () => {
    const content = await draft();
    await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "postiz",
        status: "read_verified",
        channels: [
          { id: "test-social", name: "Unknown", identifier: "future-network" },
        ],
        assignedIntegrationIds: ["test-social"],
      }),
    );
    const long = await run((tx) =>
      update(tx, scope, content, { ...data(content), body: "a".repeat(5000) }),
    );
    expect(
      (await run((tx) => checkClaims(tx, scope, long.id))).problems,
    ).not.toContain("CHANNEL_LIMIT_EXCEEDED");
    expect(
      (await run((tx) => preflight(tx, scope, long.id, { test: false })))
        .blockers,
    ).toContain("CHANNEL_CAPABILITY_UNVERIFIED");
  });
  it("A09/A11/A21: Assisted needs an exact once-consumed versioned approval", async () => {
    const c = await draft();
    await run(async (tx) => {
      const [p] = await tx.entity.findMany({
        where: { projectId: scope.projectId, kind: "policies" },
      });
      await update(tx, scope, p, { ...policy, active: true, mode: "assisted" });
    });
    const p = await run((tx) => preflight(tx, scope, c.id, { test: true }));
    expect(p.blockers).toContain("APPROVAL_REQUIRED");
    await run((tx) =>
      approve(tx, scope, {
        contentId: c.id,
        version: c.version,
        packageHash: p.packageHash,
      }),
    );
    expect(
      (await run((tx) => preflight(tx, scope, c.id, { test: true }))).blockers,
    ).not.toContain("APPROVAL_REQUIRED");
    await run((tx) =>
      update(tx, scope, c, { ...data(c), body: "Different text" }),
    );
    await expect(
      run((tx) =>
        approve(tx, scope, {
          contentId: c.id,
          version: c.version,
          packageHash: p.packageHash,
        }),
      ),
    ).rejects.toThrow("STALE_APPROVAL");
  });
  it("A12/K29: parallel reservations cannot exceed daily limit; unknown is reserved", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        run((tx) =>
          reserve(tx, scope, "parallel-" + i, "embedding", 30, policy as any),
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(3);
    const first = (results.find((x) => x.status === "fulfilled") as any).value;
    await run((tx) => settle(tx, scope, first.id, null));
    await expect(
      run((tx) =>
        reserve(tx, scope, "after-unknown", "query", 11, policy as any),
      ),
    ).rejects.toThrow("BUDGET_EXCEEDED");
  });
  it("A22: pause denies new intents even with valid previous approvals", async () => {
    const c = await draft();
    await auth.project.update({
      where: { id: scope.projectId },
      data: { paused: true },
    });
    const p = await run((tx) => preflight(tx, scope, c.id, { test: true }));
    expect(p.blockers).toContain("PROJECT_PAUSED");
    await auth.project.update({
      where: { id: scope.projectId },
      data: { paused: false },
    });
  });
  it("A27/K27: small sample creates hypothesis with explicit limitations", async () => {
    await run((tx) =>
      create(tx, scope, "metrics", {
        source: "manual_test",
        externalId: "metric",
        campaign: "synthetic",
        sampleSize: 3,
        clicks: 2,
        sessions: null,
        conversions: null,
        costMicros: 0,
      }),
    );
    const insight = await run((tx) => analyze(tx, scope, "synthetic"));
    expect(data(insight).status).toBe("hypothesis");
    expect(data(insight).sessions).toBeNull();
    expect(data(insight).limitations.join(" ")).toContain("no winner");
  });
  it("K16/K24: revoke invalidates public evidence and content and removes chunks", async () => {
    const e = await run((tx) =>
      retrieve(tx, scope, {
        query: "price",
        purpose: "public",
        language: "en",
      }),
    );
    expect(data(e).facts.length).toBeGreaterThan(0);
    await run((tx) => revokeSource(tx, scope, sourceId));
    expect(
      await run((tx) =>
        tx.knowledgeChunk.count({ where: { projectId: scope.projectId } }),
      ),
    ).toBe(0);
    expect(
      data(await run((tx) => tx.entity.findUnique({ where: { id: e.id } })))
        .status,
    ).toBe("invalidated");
  });
});
