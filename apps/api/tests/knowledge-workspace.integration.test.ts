import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  knowledgeDraft,
  type KnowledgeSnapshot,
} from "../../../packages/schemas/src/knowledge-workspace.ts";
import { create, data, entity, hash, list, update } from "../src/shared.ts";
import {
  saveDraft,
  previewDraft,
  startAnalysis,
  runAnalysis,
  decideProposal,
  completeAnalysis,
  cancelAnalysis,
  workspaceSummary,
  validateProposalEvidence,
  readKnowledgeFile,
  getKnowledgePreview,
} from "../src/modules/knowledge/workspace.ts";
import { retrieve } from "../../../packages/knowledge/src/index.ts";
import { exportProject } from "../src/platform/governance/export.ts";
import { planCall } from "../src/platform/ai/call-plan.ts";
import { respond } from "../../../packages/ai/src/index.ts";
import {
  readRepository,
  githubToken,
} from "../src/modules/knowledge/github.ts";
vi.mock("../src/modules/knowledge/github.ts", async (original) => ({
  ...(await original<typeof import("../src/modules/knowledge/github.ts")>()),
  readRepository: vi.fn(),
  githubToken: vi.fn(),
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(),
}));
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const HOUR = 3600000;
vi.mock("../src/platform/ai/call-plan.ts", () => ({
  planCall: vi.fn(async () => ({
    route: { model: "gpt-5.6-terra", maxOutputTokens: 3000 },
    provider: "openai",
    estimateMicros: 100,
    fallbackFrom: null,
  })),
}));
describe.skipIf(!enabled)("reviewed knowledge workspace", () => {
  let s: Scope;
  let workspaceId: string;
  let userId: string;
  const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(s.workspaceId, s.projectId, fn);
  beforeAll(async () => {
    userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic knowledge owner",
        email: `${userId}@example.invalid`,
      },
    });
    const w = await authDb.workspace.create({
      data: {
        name: "Synthetic knowledge",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaceId = w.id;
  });
  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "synthetic-knowledge-key";
    process.env.ORBIT_KNOWLEDGE_WORKSPACE = "true";
    const p = await authDb.project.create({
      data: { workspaceId, name: "Synthetic FamilyPlan" },
    });
    s = { workspaceId, projectId: p.id, userId, role: "owner" };
    vi.mocked(respond).mockReset();
    vi.mocked(readRepository).mockReset();
    vi.mocked(githubToken).mockResolvedValue({
      token: "synthetic",
      repository: {
        id: 1,
        full_name: "example/family",
        default_branch: "main",
        private: true,
      },
    });
  });
  afterAll(async () => {
    await authDb.workspace.delete({ where: { id: workspaceId } });
    await authDb.user.delete({ where: { id: userId } });
    await closeDatabase();
  });
  const manual = () =>
    knowledgeDraft.parse({
      name: "FamilyPlan docs",
      kind: "manual",
      text: "FamilyPlan organizes shared calendars.",
      modelUse: false,
    });
  const prepare = async (input = manual()) => {
    const draft = await saveDraft(s, input);
    const preview = await previewDraft(s, { draftId: draft.id });
    const job = await startAnalysis(s, { previewId: preview.id });
    return { draft, preview, job };
  };
  const proposals = () => run((tx) => list(tx, s, "knowledge_proposals"));
  const approve = async (p: any, extra = {}) =>
    decideProposal(s, {
      proposalId: p.id,
      version: p.version,
      decision: "accept",
      ...extra,
    });
  const search = async () =>
    data(
      await run((tx) =>
        retrieve(tx, s, {
          query: "FamilyPlan calendars",
          purpose: "internal",
          forModel: true,
          consumer: "marketing",
          language: "de",
        }),
      ),
    );
  it("quarantines raw text and proposals until explicit confirmation", async () => {
    const { job } = await prepare();
    expect((await search()).items).toHaveLength(0);
    expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
    const [p] = await proposals();
    expect(data(p).status).toBe("pending");
    expect(
      await run((tx) =>
        tx.knowledgeDocument.count({ where: { projectId: s.projectId } }),
      ),
    ).toBe(0);
    expect((await search()).items).toHaveLength(0);
    await approve(p);
    const summary = await workspaceSummary(s);
    expect(summary.enabled).toBe(true);
    expect(
      await run((tx) =>
        tx.knowledgeDocument.count({ where: { projectId: s.projectId } }),
      ),
    ).toBe(1);
    const found = await search();
    expect(found.items.length + found.facts.length).toBeGreaterThan(0);
    const publicResult = data(
      await run((tx) =>
        retrieve(tx, s, {
          query: "FamilyPlan",
          purpose: "public",
          forModel: true,
          consumer: "marketing",
          language: "de",
        }),
      ),
    );
    expect(publicResult.items).toHaveLength(0);
    expect(publicResult.facts).toHaveLength(0);
    expect(vi.mocked(respond)).not.toHaveBeenCalled();
  });
  it("limits accepted evidence to the selected modules", async () => {
    const { job } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0], { audiences: ["support"] });
    expect((await search()).items).toHaveLength(0);
    const result = data(
      await run((tx) =>
        retrieve(tx, s, {
          query: "FamilyPlan",
          purpose: "internal",
          forModel: true,
          consumer: "support",
          language: "de",
        }),
      ),
    );
    expect(result.items.length + result.facts.length).toBeGreaterThan(0);
  });
  it("records edited decisions and prevents double promotion under concurrency", async () => {
    const { job } = await prepare();
    await runAnalysis(s, job.id);
    const [p] = await proposals();
    const results = await Promise.allSettled([
      approve(p, { statement: "FamilyPlan supports shared calendars." }),
      approve(p),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await run((tx) =>
        tx.knowledgeDocument.count({ where: { projectId: s.projectId } }),
      ),
    ).toBe(1);
    expect(
      await run((tx) => tx.entityVersion.count({ where: { entityId: p!.id } })),
    ).toBe(2);
  });
  it("does not duplicate jobs or proposals on repeated starts and execution", async () => {
    const { job, preview } = await prepare();
    expect((await startAnalysis(s, { previewId: preview.id })).id).toBe(job.id);
    await runAnalysis(s, job.id);
    await runAnalysis(s, job.id);
    expect(await proposals()).toHaveLength(1);
  });
  it("invalidates accepted knowledge when the evidence changes", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    const current = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: current.version,
      text: "FamilyPlan supports shared shopping lists.",
    });
    const preview = await previewDraft(s, { draftId: draft.id });
    const next = await startAnalysis(s, { previewId: preview.id });
    await runAnalysis(s, next.id);
    const rows = await proposals();
    expect(rows.map((p) => data(p).status).sort()).toEqual([
      "needs_review",
      "pending",
    ]);
    expect((await search()).items).toHaveLength(0);
    expect((await search()).facts).toHaveLength(0);
  });
  it("rejects confirmation against an obsolete snapshot", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    const [old] = await proposals();
    const current = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: current.version,
      text: "Updated documentation.",
    });
    const preview = await previewDraft(s, { draftId: draft.id });
    const next = await startAnalysis(s, { previewId: preview.id });
    await runAnalysis(s, next.id);
    await expect(approve(old)).rejects.toThrow(
      /KNOWLEDGE_EVIDENCE_CHANGED|VERSION_CONFLICT/,
    );
  });
  it("cancels before execution and keeps content quarantined", async () => {
    const { job } = await prepare();
    await cancelAnalysis(s, { runId: job.id });
    expect((await runAnalysis(s, job.id)).status).toBe("canceled");
    expect(await proposals()).toHaveLength(0);
  });
  it("blocks a worker after the initiating owner loses access", async () => {
    const { job } = await prepare();
    await authDb.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role: "viewer" },
    });
    try {
      expect((await runAnalysis(s, job.id)).errorCode).toBe("OWNER_REQUIRED");
      expect(await proposals()).toHaveLength(0);
    } finally {
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: "owner" },
      });
    }
  });
  it("blocks writes and jobs when the feature is disabled", async () => {
    const { job } = await prepare();
    process.env.ORBIT_KNOWLEDGE_WORKSPACE = "false";
    expect(await workspaceSummary(s)).toEqual({ enabled: false });
    await expect(saveDraft(s, manual())).rejects.toThrow(
      "KNOWLEDGE_WORKSPACE_DISABLED",
    );
    expect((await runAnalysis(s, job.id)).status).toBe("blocked_dependency");
  });
  it("enforces project boundaries even for an owner of both projects", async () => {
    const { draft } = await prepare();
    const other = await authDb.project.create({
      data: { workspaceId, name: "Other" },
    });
    await expect(
      previewDraft({ ...s, projectId: other.id }, { draftId: draft.id }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("excludes staging, OAuth and credentials from project exports", async () => {
    await prepare();
    await run((tx) =>
      create(tx, s, "knowledge_github_config", {
        encryptedCredential: "synthetic encrypted",
      }),
    );
    const exported = await run((tx) => exportProject(tx, s));
    expect(exported.entities.some((e) => e.kind.startsWith("knowledge_"))).toBe(
      false,
    );
  });
  it("validates exact quoted lines before accepting an analyst finding", () => {
    const snap: KnowledgeSnapshot = {
      commit: "a".repeat(40),
      files: [{ path: "README.md", text: "First\nSecond", hash: "hash" }],
      partial: false,
      skipped: 0,
    };
    const proposal = {
      statement: "Finding",
      topic: "features" as const,
      stage: "documented" as const,
      reason: "Evidence",
      evidence: { path: "README.md", startLine: 1, endLine: 1, quote: "Wrong" },
    };
    expect(() => validateProposalEvidence(proposal, snap)).toThrow(
      "KNOWLEDGE_EVIDENCE_INVALID",
    );
    expect(() =>
      validateProposalEvidence(
        { ...proposal, evidence: { ...proposal.evidence, quote: "First" } },
        snap,
      ),
    ).not.toThrow();
  });
  it("does not treat an incomplete scan as proof of a removed file", async () => {
    const { job } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    await run(async (tx) => {
      const old = await entity(tx, s, "knowledge_runs", job.id);
      const next = await create(tx, s, "knowledge_runs", {
        ...data(old),
        status: "analyzing",
        snapshot: {
          commit: "b".repeat(40),
          files: [],
          partial: true,
          skipped: 1,
        },
      });
      await completeAnalysis(tx, s, next.id, []);
    });
    expect(data((await proposals())[0]).status).toBe("accepted");
  });
  it("extracts a bounded document without publishing it", async () => {
    const result = await readKnowledgeFile(s, {
      name: "README.md",
      base64: Buffer.from("Shared calendars").toString("base64"),
    });
    expect(result.text).toContain("Shared calendars");
    expect(await proposals()).toHaveLength(0);
    await expect(
      readKnowledgeFile(s, {
        name: "private.pem",
        base64: Buffer.from("no").toString("base64"),
      }),
    ).rejects.toThrow("KNOWLEDGE_FILE_TYPE_UNSUPPORTED");
  });
  it("saves incomplete setup and requires a complete source before preview", async () => {
    const draft = await saveDraft(s, {
      ...manual(),
      kind: "github",
      text: "",
      partial: true,
    });
    await expect(previewDraft(s, { draftId: draft.id })).rejects.toThrow();
    expect(data(draft).input.kind).toBe("github");
  });
  async function paidSource() {
    await run((tx) =>
      create(tx, s, "policies", {
        mode: "assisted",
        channels: ["synthetic"],
        contentTypes: ["social"],
        allowedOrigins: ["https://example.invalid"],
        startAt: new Date(Date.now() - HOUR).toISOString(),
        endAt: new Date(Date.now() + HOUR).toISOString(),
        maxPerDay: 2,
        minIntervalMinutes: 60,
        dailyBudgetMicros: 1000000,
        monthlyBudgetMicros: 20000000,
        perRunBudgetMicros: 200000,
        approvedPaidTests: true,
        active: true,
      }),
    );
    return prepare({ ...manual(), modelUse: true });
  }
  it("uses a tool-free budgeted model call and validates grounded output", async () => {
    const { job } = await paidSource();
    vi.mocked(respond).mockResolvedValue({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                proposals: [
                  {
                    statement: "Shared calendars",
                    topic: "features",
                    stage: "documented",
                    reason: "README",
                    evidence: {
                      path: "FamilyPlan docs",
                      startLine: 1,
                      endLine: 1,
                      quote: manual().text,
                    },
                  },
                ],
              }),
            },
          ],
        },
      ],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 20,
        outputTokens: 20,
        cachedTokens: 0,
        reasoningTokens: 0,
        costMicros: 50,
      },
      responseId: "synthetic-response",
    } as any);
    expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
    const request = vi.mocked(respond).mock.calls[0]![0];
    expect(request.tools).toEqual([]);
    expect(request.instructions).toContain("Maximum 3 proposals");
    expect((request.outputSchema as any).properties.proposals.maxItems).toBe(3);
    expect(data((await proposals())[0]).status).toBe("pending");
    expect(
      (
        await run((tx) =>
          tx.budgetReservation.findFirst({ where: { projectId: s.projectId } }),
        )
      )?.state,
    ).toBe("settled");
  });
  it("keeps ambiguous transmitted calls unknown and blocks a fresh analysis", async () => {
    const { job, draft } = await paidSource();
    vi.mocked(respond).mockRejectedValue(
      new Error("Synthetic transport interruption"),
    );
    expect((await runAnalysis(s, job.id)).errorCode).toBe(
      "KNOWLEDGE_COST_UNKNOWN",
    );
    const preview = await previewDraft(s, { draftId: draft.id });
    await expect(startAnalysis(s, { previewId: preview.id })).rejects.toThrow(
      "KNOWLEDGE_COST_UNKNOWN",
    );
    expect(vi.mocked(respond)).toHaveBeenCalledTimes(1);
  });
  it("preserves a model readiness error before reserving or transmitting", async () => {
    const { job } = await paidSource();
    vi.mocked(planCall).mockRejectedValueOnce(
      new Error("MODEL_CAPABILITY_NOT_VERIFIED"),
    );
    expect((await runAnalysis(s, job.id)).errorCode).toBe(
      "MODEL_CAPABILITY_NOT_VERIFIED",
    );
    expect(respond).not.toHaveBeenCalled();
    expect(
      await run((tx) =>
        tx.budgetReservation.count({ where: { projectId: s.projectId } }),
      ),
    ).toBe(0);
  });
  it("reports output exhaustion, settles the known cost and never promotes truncated JSON", async () => {
    const { job } = await paidSource();
    vi.mocked(respond).mockResolvedValue({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: '{"proposals":[' }],
        },
      ],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 20,
        outputTokens: 3000,
        costMicros: 50,
      },
      responseId: "synthetic-truncated-response",
    } as any);
    expect((await runAnalysis(s, job.id)).errorCode).toBe(
      "KNOWLEDGE_OUTPUT_LIMIT",
    );
    expect(respond).toHaveBeenCalledTimes(1);
    expect(await proposals()).toHaveLength(0);
    const saved = await run((tx) => entity(tx, s, "knowledge_runs", job.id));
    expect(data(saved).outputDiagnostics).toMatchObject({
      outputTokens: 3000,
      maxOutputTokens: 3000,
      proposalLimit: 3,
    });
    expect(
      await run((tx) =>
        tx.budgetReservation.findFirst({ where: { projectId: s.projectId } }),
      ),
    ).toMatchObject({ state: "settled", settledMicros: 50n });
  });
  it("rejects fabricated quotes after settling known model usage", async () => {
    const { job } = await paidSource();
    vi.mocked(respond).mockResolvedValue({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                proposals: [
                  {
                    statement: "Released",
                    topic: "features",
                    stage: "documented",
                    reason: "Claim",
                    evidence: {
                      path: "FamilyPlan docs",
                      startLine: 1,
                      endLine: 1,
                      quote: "not in the source",
                    },
                  },
                ],
              }),
            },
          ],
        },
      ],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 20,
        outputTokens: 20,
        costMicros: 50,
      },
      responseId: "synthetic-response",
    } as any);
    expect((await runAnalysis(s, job.id)).errorCode).toBe(
      "KNOWLEDGE_EVIDENCE_INVALID",
    );
    expect(await proposals()).toHaveLength(0);
  });
  it("keeps the proposals with exact quotes and drops the others", async () => {
    const { job } = await paidSource();
    const stored = async () =>
      data(await run((tx) => entity(tx, s, "knowledge_runs", job.id)));
    const snap = (await stored()).snapshot;
    const line = String(snap.files[0].text).split("\n")[0];
    const proposal = (quote: string, statement: string) => ({
      statement,
      topic: "features",
      stage: "documented",
      reason: "Claim",
      evidence: { path: snap.files[0].path, startLine: 1, endLine: 1, quote },
    });
    vi.mocked(respond).mockResolvedValue({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                proposals: [proposal(line, "Exact"), proposal("not in the source", "Inexact")],
              }),
            },
          ],
        },
      ],
      usage: { model: "gpt-5.6-terra", inputTokens: 20, outputTokens: 20, costMicros: 50 },
      responseId: "synthetic-response",
    } as any);
    expect((await runAnalysis(s, job.id)).errorCode).toBeNull();
    expect((await proposals()).map((p: any) => data(p).statement)).toEqual(["Exact"]);
    expect((await stored()).droppedProposals).toBe(1);
  });
  it("reads only an unexpired preview for the unchanged draft", async () => {
    const draft = await saveDraft(s, manual());
    const preview = await previewDraft(s, { draftId: draft.id });
    expect((await getKnowledgePreview(s, preview.id)).files).toHaveLength(1);
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: draft.version,
      text: "Changed",
    });
    await expect(getKnowledgePreview(s, preview.id)).rejects.toThrow(
      "KNOWLEDGE_PREVIEW_EXPIRED",
    );
  });
  it("does not create new findings for unchanged source contents", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    const preview = await previewDraft(s, { draftId: draft.id });
    const next = await startAnalysis(s, { previewId: preview.id });
    await runAnalysis(s, next.id);
    expect(await proposals()).toHaveLength(1);
    expect(data((await proposals())[0]).status).toBe("accepted");
    expect(vi.mocked(respond)).not.toHaveBeenCalled();
  });
  it("withdraws evidence from a complete scan that removes a file", async () => {
    const { job } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    await run(async (tx) => {
      const old = await entity(tx, s, "knowledge_runs", job.id);
      const next = await create(tx, s, "knowledge_runs", {
        ...data(old),
        status: "analyzing",
        snapshot: {
          commit: "b".repeat(40),
          files: [],
          partial: false,
          skipped: 0,
        },
      });
      await completeAnalysis(tx, s, next.id, []);
    });
    expect(data((await proposals())[0]).status).toBe("needs_review");
    expect((await search()).facts).toHaveLength(0);
  });
  it("does not promote a paid response that completes after cancellation", async () => {
    const { job } = await paidSource();
    let finish!: (v: any) => void;
    vi.mocked(respond).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = runAnalysis(s, job.id);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    await cancelAnalysis(s, { runId: job.id });
    finish({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify({ proposals: [] }) },
          ],
        },
      ],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 20,
        outputTokens: 20,
        costMicros: 50,
      },
      responseId: "synthetic-response",
    });
    expect((await running).status).toBe("canceled");
    expect(await proposals()).toHaveLength(0);
    expect(
      (
        await run((tx) =>
          tx.budgetReservation.findFirst({ where: { projectId: s.projectId } }),
        )
      )?.state,
    ).toBe("settled");
  });
  it("withholds changed evidence as soon as a successful preview reads it, even without an AI mandate", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    const current = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: current.version,
      text: "New documentation",
      modelUse: true,
    });
    const preview = await previewDraft(s, { draftId: draft.id });
    expect(data((await proposals())[0]).status).toBe("needs_review");
    expect((await search()).facts).toHaveLength(0);
    await expect(startAnalysis(s, { previewId: preview.id })).rejects.toThrow(
      "POLICY_REQUIRED",
    );
  });
  it("preserves confirmed knowledge after a failed source fetch", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    const current = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: current.version,
      kind: "github",
      connectionId: randomUUID(),
      repositoryId: 1,
      repository: "example/family",
    });
    vi.mocked(readRepository).mockRejectedValue(
      new Error("Synthetic fetch failure"),
    );
    await expect(previewDraft(s, { draftId: draft.id })).rejects.toThrow(
      "Synthetic fetch failure",
    );
    expect(data((await proposals())[0]).status).toBe("accepted");
    const found = await search();
    expect(found.items.length + found.facts.length).toBeGreaterThan(0);
  });
  it("can review previously invalidated evidence when a file is reverted", async () => {
    const { job, draft } = await prepare();
    await runAnalysis(s, job.id);
    await approve((await proposals())[0]);
    const current = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, {
      ...manual(),
      id: draft.id,
      version: current.version,
      text: "Changed text",
    });
    await previewDraft(s, { draftId: draft.id });
    const changed = await run((tx) =>
      entity(tx, s, "knowledge_drafts", draft.id),
    );
    await saveDraft(s, { ...manual(), id: draft.id, version: changed.version });
    const preview = await previewDraft(s, { draftId: draft.id });
    const next = await startAnalysis(s, { previewId: preview.id });
    await runAnalysis(s, next.id);
    expect((await proposals()).some((p) => data(p).status === "pending")).toBe(
      true,
    );
  });
  it("reports a missing model key before reserving or transmitting a paid call", async () => {
    delete process.env.OPENAI_API_KEY;
    const { job } = await paidSource();
    expect((await runAnalysis(s, job.id)).errorCode).toBe(
      "KNOWLEDGE_MODEL_NOT_CONFIGURED",
    );
    expect(respond).not.toHaveBeenCalled();
    expect(
      await run((tx) =>
        tx.budgetReservation.count({ where: { projectId: s.projectId } }),
      ),
    ).toBe(0);
  });
  it("requires consent and budget for GitHub analysis", async () => {
    vi.mocked(readRepository).mockResolvedValue({
      commit: "a".repeat(40),
      files: [
        {
          path: "README.md",
          text: "Shared calendar",
          hash: hash("Shared calendar"),
        },
      ],
      partial: false,
      skipped: 0,
    });
    const draft = await saveDraft(s, {
      ...manual(),
      kind: "github",
      connectionId: randomUUID(),
      repositoryId: 1,
      repository: "example/family",
    });
    const p = await previewDraft(s, { draftId: draft.id });
    await expect(startAnalysis(s, { previewId: p.id })).rejects.toThrow(
      "MODEL_USE_FORBIDDEN",
    );
    const next = await saveDraft(s, {
      ...data(draft).input,
      id: draft.id,
      version: draft.version,
      modelUse: true,
    });
    const p2 = await previewDraft(s, { draftId: next.id });
    await expect(startAnalysis(s, { previewId: p2.id })).rejects.toThrow(
      "POLICY_REQUIRED",
    );
    expect(vi.mocked(respond)).not.toHaveBeenCalled();
  });
});
