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
  analysisPreflight,
  directTextProposals,
  runAnalysis,
  decideProposal,
  completeAnalysis,
  cancelAnalysis,
  workspaceSummary,
  validateProposalEvidence,
  readKnowledgeFile,
  getKnowledgePreview,
  removeProposal,
  restoreProposal,
  editProposal,
} from "../src/modules/knowledge/workspace.ts";
import { knowledgeActions } from "../src/modules/knowledge/actions.ts";
import { knowledgeActionPermissions } from "../src/modules/knowledge/permissions.ts";
import { can } from "../src/platform/tenancy/permissions.ts";
import { KnowledgeError } from "../../../packages/knowledge/src/index.ts";
import { retrieve } from "../../../packages/knowledge/src/index.ts";
import {
  resumeSource,
  ingest,
  revokeDocument,
  revokeSource,
  setFact,
  setSourceRights,
  withdrawFact,
} from "../src/platform/knowledge/engine.ts";
import { exportProject } from "../src/platform/governance/export.ts";
import { planCall } from "../src/platform/ai/call-plan.ts";
import { respond } from "../../../packages/ai/src/index.ts";
import { knowledgeSearch } from "../src/platform/knowledge/search.ts";
import {
  readRepository,
  githubToken,
} from "../src/modules/knowledge/github.ts";
vi.mock("../src/modules/knowledge/github.ts", async (original) => ({
  ...(await original<typeof import("../src/modules/knowledge/github.ts")>()),
  readRepository: vi.fn(),
  githubToken: vi.fn(),
}));
// Delegates to the real engine; one test makes the ingest refuse.
vi.mock("../src/platform/knowledge/engine.ts", async (original) => {
  const real =
    await original<typeof import("../src/platform/knowledge/engine.ts")>();
  return { ...real, ingest: vi.fn(real.ingest) };
});
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
  const routeWith = (maxOutputTokens: number, estimateMicros = 100) =>
    vi.mocked(planCall).mockResolvedValue({
      route: { model: "gpt-5.6-terra", maxOutputTokens },
      provider: "openai",
      estimateMicros,
      fallbackFrom: null,
    });
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
    routeWith(3000);
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
    const job = await startAnalysis(s, {
      previewId: preview.id,
      ...(input.modelUse ? { confirmModelUse: true } : {}),
    });
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
  describe("the owner's rights on a draft", () => {
    const rights = (over: Record<string, boolean> = {}) => ({
      marketing: true,
      support: true,
      publicUse: false,
      modelUse: true,
      ...over,
    });
    const accepted = async (input: ReturnType<typeof manual>) => {
      const { job } = await prepare(input);
      await runAnalysis(s, job.id);
      const row = await approve((await proposals())[0]);
      const d = data(row);
      return run(async (tx) => ({
        source: data(await entity(tx, s, "sources", d.sourceId)),
        fact: data(await entity(tx, s, "facts", d.factId)),
      }));
    };
    it("keeps a statement out of AI features when its draft says so", async () => {
      const { source, fact } = await accepted({
        ...manual(),
        rights: rights({ modelUse: false }),
      });
      expect(source.modelUse).toBe(false);
      expect(fact.modelUse).toBe(false);
      const found = await search();
      expect(found.items).toHaveLength(0);
      expect(found.facts).toHaveLength(0);
    });
    it("leaves a statement AI-readable when its draft allows it", async () => {
      const { source, fact } = await accepted({
        ...manual(),
        rights: rights(),
      });
      expect(source.modelUse).toBe(true);
      expect(fact.modelUse).toBe(true);
      const found = await search();
      expect(found.items.length + found.facts.length).toBeGreaterThan(0);
    });
    it("treats an older draft without rights as AI-readable", async () => {
      const { source, fact } = await accepted(manual());
      expect(source.modelUse).toBe(true);
      expect(fact.modelUse).toBe(true);
    });
    it("does not read the draft's own modelUse as the statement's right", async () => {
      // `modelUse` on the draft says whether the analysis calls a model.
      const { source } = await accepted({
        ...manual(),
        modelUse: false,
        rights: rights({ modelUse: true }),
      });
      expect(source.modelUse).toBe(true);
    });
    it("refuses rights with unknown or missing fields", async () => {
      await expect(
        saveDraft(s, { ...manual(), rights: { marketing: true } }),
      ).rejects.toThrow();
      await expect(
        saveDraft(s, { ...manual(), rights: { ...rights(), extra: true } }),
      ).rejects.toThrow();
    });
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
  it("delivers the latest run per site source without its page lists", async () => {
    const urls = Array.from({ length: 200 }, (_, i) => `https://x.test/p${i}`);
    await run(async (tx) => {
      const make = (name: string, lastRunId?: string) =>
        create(tx, s, "sources", {
          name,
          type: "website",
          status: "active",
          site: { rootUrl: "https://x.test/", lastRunId },
        });
      const newer = await create(tx, s, "knowledge_site_runs", {
        status: "completed",
        pages: urls,
        languages: urls.map(() => "de"),
        failed: [{ url: urls[0], code: "SITE_PAGE_FAILED" }],
        warning: null,
      });
      const older = await create(tx, s, "knowledge_site_runs", {
        status: "completed",
        pages: [urls[0]],
        languages: ["de"],
        failed: [],
        warning: null,
      });
      await make("A", newer.id);
      // Not the source's latest run: it must not be delivered.
      await make("B", undefined);
      return older;
    });
    const summary: any = await workspaceSummary(s);
    expect(summary.siteRuns).toHaveLength(1);
    const [row] = summary.siteRuns;
    expect(row.data.pageCount).toBe(200);
    expect(row.data.failed).toHaveLength(1);
    expect(row.data).not.toHaveProperty("pages");
    expect(row.data).not.toHaveProperty("languages");
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
  const spendPolicy = (overrides: Record<string, unknown> = {}) =>
    run((tx) =>
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
        ...overrides,
      }),
    );
  async function paidSource() {
    await spendPolicy();
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
                proposals: [
                  proposal(line, "Exact"),
                  proposal("not in the source", "Inexact"),
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
    expect((await runAnalysis(s, job.id)).errorCode).toBeNull();
    expect((await proposals()).map((p: any) => data(p).statement)).toEqual([
      "Exact",
    ]);
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
  describe("keeping confirmed knowledge recoverable", () => {
    const accepted = async () => {
      const { job, draft } = await prepare();
      await runAnalysis(s, job.id);
      await approve((await proposals())[0]);
      return { draft, p: (await proposals())[0]! };
    };
    const changeSource = async (
      draftId: string,
      text = "FamilyPlan supports shared shopping lists.",
    ) => {
      const current = await run((tx) =>
        entity(tx, s, "knowledge_drafts", draftId),
      );
      await saveDraft(s, {
        ...manual(),
        id: draftId,
        version: current.version,
        text,
      });
      return previewDraft(s, { draftId });
    };
    const ref = (p: { id: string; version: number }) => ({
      proposalId: p.id,
      version: p.version,
    });
    const documents = () =>
      run((tx) =>
        tx.knowledgeDocument.count({ where: { projectId: s.projectId } }),
      );
    const sourceOf = (p: any) =>
      run((tx) => entity(tx, s, "sources", data(p).sourceId));
    const factOf = (p: any) =>
      run((tx) => entity(tx, s, "facts", data(p).factId));
    const retrievableFacts = async (key: string) =>
      (
        data(
          await run((tx) =>
            retrieve(tx, s, {
              query: "FamilyPlan",
              purpose: "internal",
              forModel: true,
              consumer: "marketing",
              language: "de",
              factKeys: [key],
            }),
          ),
        ).facts as Array<{ key: string }>
      ).map((f) => f.key);
    const curatedFact = (p: any) =>
      run((tx) =>
        setFact(tx, s, {
          sourceId: data(p).sourceId,
          key: "plans.calendars",
          value: "Calendars are included",
          valueType: "text",
          language: "de",
          validFrom: new Date().toISOString(),
          status: "verified",
          publicUse: false,
          modelUse: true,
        }),
      );
    const asViewer = async (check: () => Promise<void>) => {
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: "viewer" },
      });
      try {
        await check();
      } finally {
        await authDb.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId } },
          data: { role: "owner" },
        });
      }
    };

    it("pauses changed knowledge at read time and erases nothing", async () => {
      const { draft, p } = await accepted();
      const curated = await curatedFact(p);
      await changeSource(draft.id);
      const [changed] = await proposals();
      expect(data(changed).status).toBe("needs_review");
      expect(data(await sourceOf(p)).status).toBe("paused");
      expect(await documents()).toBe(1);
      const kept = await run((tx) => entity(tx, s, "facts", curated.id));
      expect(data(kept).value).toBe("Calendars are included");
      expect(data(kept).status).toBe("verified");
      const found = await search();
      expect(found.items).toHaveLength(0);
      expect(found.facts).toHaveLength(0);
      expect(await retrievableFacts("plans.calendars")).toEqual([]);
    });
    it("restores paused knowledge and every fact of its source", async () => {
      const { draft, p } = await accepted();
      await curatedFact(p);
      const own = String(data(await factOf(p)).key);
      await changeSource(draft.id);
      const [changed] = await proposals();
      const restored = await restoreProposal(s, ref(changed!));
      expect(data(restored).status).toBe("accepted");
      expect(data(await sourceOf(p)).status).toBe("active");
      expect((await search()).items.length).toBeGreaterThan(0);
      expect(await retrievableFacts(own)).toEqual([own]);
      expect(await retrievableFacts("plans.calendars")).toEqual([
        "plans.calendars",
      ]);
    });
    it("removes a confirmed statement from use and can bring it back", async () => {
      const { p } = await accepted();
      const own = String(data(await factOf(p)).key);
      const removed = await removeProposal(s, ref(p));
      expect(data(removed).status).toBe("removed");
      expect(await documents()).toBe(1);
      expect((await search()).items).toHaveLength(0);
      expect(await retrievableFacts(own)).toEqual([]);
      const restored = await restoreProposal(s, ref(removed));
      expect(data(restored).status).toBe("accepted");
      expect((await search()).items.length).toBeGreaterThan(0);
      expect(await retrievableFacts(own)).toEqual([own]);
    });
    it("does not propose a removed statement again for unchanged text", async () => {
      const { draft, p } = await accepted();
      await removeProposal(s, ref(p));
      const preview = await previewDraft(s, { draftId: draft.id });
      const next = await startAnalysis(s, { previewId: preview.id });
      await runAnalysis(s, next.id);
      expect((await proposals()).map((x) => data(x).status)).toEqual([
        "removed",
      ]);
    });
    it("restores a statement whose fact was withdrawn separately", async () => {
      const { p } = await accepted();
      const fact = await factOf(p);
      await run((tx) => withdrawFact(tx, s, fact.id, fact.version));
      const restored = await restoreProposal(s, ref(p));
      expect(data(restored).status).toBe("accepted");
      expect(data(await factOf(p)).status).toBe("verified");
    });
    it("corrects a statement in the fact and the searchable document", async () => {
      const { p } = await accepted();
      const edited = await editProposal(s, {
        ...ref(p),
        statement: "FamilyPlan shares family calendars.",
      });
      expect(data(edited).statement).toBe(
        "FamilyPlan shares family calendars.",
      );
      expect(data(await factOf(p)).value).toBe(
        "FamilyPlan shares family calendars.",
      );
      expect(data(await factOf(p)).status).toBe("verified");
      const titles = await run((tx) =>
        tx.documentVersion.findMany({
          where: { projectId: s.projectId, state: "active" },
          select: { title: true },
        }),
      );
      expect(titles).toEqual([
        { title: "FamilyPlan shares family calendars." },
      ]);
    });
    it("corrects a statement whose document was revoked earlier", async () => {
      const { p } = await accepted();
      const document = await run((tx) =>
        tx.knowledgeDocument.findFirstOrThrow({
          where: { projectId: s.projectId },
        }),
      );
      await run((tx) => revokeDocument(tx, s, document.id));
      const edited = await editProposal(s, {
        ...ref(p),
        statement: "A corrected statement.",
      });
      expect(data(edited).statement).toBe("A corrected statement.");
      expect(await documents()).toBe(0);
    });
    it("refuses a restore once the source was revoked for good", async () => {
      const { p } = await accepted();
      await run((tx) => revokeSource(tx, s, data(p).sourceId));
      await expect(restoreProposal(s, ref(p))).rejects.toThrow(
        "KNOWLEDGE_RESTORE_UNAVAILABLE",
      );
    });
    it("refuses a restore of knowledge that is still in use", async () => {
      const { p } = await accepted();
      await expect(restoreProposal(s, ref(p))).rejects.toThrow(
        "KNOWLEDGE_RESTORE_UNAVAILABLE",
      );
    });
    it("refuses stale versions", async () => {
      const { p } = await accepted();
      const old = { proposalId: p.id, version: p.version - 1 };
      await expect(removeProposal(s, old)).rejects.toThrow("VERSION_CONFLICT");
      await expect(
        editProposal(s, { ...old, statement: "Other" }),
      ).rejects.toThrow("VERSION_CONFLICT");
    });
    it("only lets owners remove, restore or edit", async () => {
      const { p } = await accepted();
      await asViewer(async () => {
        await expect(removeProposal(s, ref(p))).rejects.toThrow(
          "OWNER_REQUIRED",
        );
        await expect(restoreProposal(s, ref(p))).rejects.toThrow(
          "OWNER_REQUIRED",
        );
        await expect(
          editProposal(s, { ...ref(p), statement: "Other" }),
        ).rejects.toThrow("OWNER_REQUIRED");
      });
      expect(data((await proposals())[0]).status).toBe("accepted");
    });
    it("keeps the actions inside their project", async () => {
      const { p } = await accepted();
      const other = await authDb.project.create({
        data: { workspaceId, name: "Other" },
      });
      const foreign = { ...s, projectId: other.id };
      await expect(removeProposal(foreign, ref(p))).rejects.toThrow(
        "NOT_FOUND",
      );
      await expect(restoreProposal(foreign, ref(p))).rejects.toThrow(
        "NOT_FOUND",
      );
      await expect(
        editProposal(foreign, { ...ref(p), statement: "Other" }),
      ).rejects.toThrow("NOT_FOUND");
    });
    it("brings the facts of a resumed source back into retrieval", async () => {
      const { p } = await accepted();
      await curatedFact(p);
      await run((tx) =>
        setSourceRights(tx, s, data(p).sourceId, { paused: true }),
      );
      expect(await retrievableFacts("plans.calendars")).toEqual([]);
      await run((tx) => resumeSource(tx, s, data(p).sourceId));
      expect(await retrievableFacts("plans.calendars")).toEqual([
        "plans.calendars",
      ]);
    });
    it("keeps kept knowledge in use when the same text is read again", async () => {
      const { draft } = await accepted();
      await changeSource(draft.id);
      await restoreProposal(s, ref((await proposals())[0]!));
      await previewDraft(s, { draftId: draft.id });
      expect(data((await proposals())[0]).status).toBe("accepted");
      expect((await search()).items.length).toBeGreaterThan(0);
    });
    it("asks again when kept knowledge changes once more", async () => {
      const { draft } = await accepted();
      await changeSource(draft.id);
      await restoreProposal(s, ref((await proposals())[0]!));
      await changeSource(draft.id, "FamilyPlan now plans meals as well.");
      expect(data((await proposals())[0]).status).toBe("needs_review");
      expect((await search()).items).toHaveLength(0);
    });
    it("leaves the other facts of a source in use after a correction", async () => {
      const { p } = await accepted();
      await curatedFact(p);
      await editProposal(s, { ...ref(p), statement: "A corrected statement." });
      expect(await retrievableFacts("plans.calendars")).toEqual([
        "plans.calendars",
      ]);
    });
    it("resumes a source that became generated without failing", async () => {
      const { p } = await accepted();
      const sourceId = data(p).sourceId;
      await curatedFact(p);
      await run((tx) =>
        setSourceRights(tx, s, sourceId, { authority: "generated" }),
      );
      await run((tx) => setSourceRights(tx, s, sourceId, { paused: true }));
      await run((tx) => resumeSource(tx, s, sourceId));
      expect(data(await sourceOf(p)).status).toBe("active");
    });
    const expertResume = (sourceId: string) =>
      run((tx) =>
        (knowledgeActions["source-pause"] as any).run(tx, {
          scope: s,
          input: { sourceId, paused: false },
        }),
      );
    it("does not let an expert resume bring a removed statement back", async () => {
      const { p } = await accepted();
      await removeProposal(s, ref(p));
      await expect(expertResume(data(p).sourceId)).rejects.toThrow(
        "KNOWLEDGE_RESTORE_REQUIRED",
      );
      expect((await search()).items).toHaveLength(0);
    });
    it("does not let an expert resume bypass a pending decision", async () => {
      const { draft, p } = await accepted();
      await changeSource(draft.id);
      await expect(expertResume(data(p).sourceId)).rejects.toThrow(
        "KNOWLEDGE_RESTORE_REQUIRED",
      );
    });
    it("lets an expert resume a source paused there", async () => {
      const { p } = await accepted();
      await run((tx) =>
        setSourceRights(tx, s, data(p).sourceId, { paused: true }),
      );
      await expertResume(data(p).sourceId);
      expect(data(await sourceOf(p)).status).toBe("active");
    });
    it("restores a statement whose source was paused separately", async () => {
      const { p } = await accepted();
      const own = String(data(await factOf(p)).key);
      await run((tx) =>
        setSourceRights(tx, s, data(p).sourceId, { paused: true }),
      );
      const restored = await restoreProposal(s, ref(p));
      expect(data(restored).status).toBe("accepted");
      expect(data(await sourceOf(p)).status).toBe("active");
      expect(await retrievableFacts(own)).toEqual([own]);
    });
    it("does not promote an unreviewed fact through remove and restore", async () => {
      const { p } = await accepted();
      const fact = await factOf(p);
      const d = data(fact);
      await run((tx) =>
        setFact(tx, s, {
          id: fact.id,
          sourceId: d.sourceId,
          key: d.key,
          value: d.value,
          valueType: d.valueType,
          language: d.language,
          validFrom: d.validFrom,
          status: "candidate",
          publicUse: d.publicUse,
          modelUse: d.modelUse,
        }),
      );
      const removed = await removeProposal(s, ref((await proposals())[0]!));
      expect(data(await factOf(p)).status).toBe("candidate");
      await restoreProposal(s, ref(removed));
      expect(data(await factOf(p)).status).toBe("candidate");
    });
    it("discards a changed proposal that was never confirmed", async () => {
      const { job, draft } = await prepare();
      await runAnalysis(s, job.id);
      await changeSource(draft.id);
      const [changed] = await proposals();
      expect(data(changed).status).toBe("needs_review");
      const result = await removeProposal(s, ref(changed!));
      expect(data(result).status).toBe("rejected");
    });
  });
  describe("AI analysis: route, preflight and consent", () => {
    const answer = (proposals: unknown[], costMicros = 50) => ({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify({ proposals }) },
          ],
        },
      ],
      usage: {
        model: "gpt-5.6-terra",
        inputTokens: 20,
        outputTokens: 20,
        costMicros,
      },
      responseId: "synthetic-response",
    });
    const paidPreview = async () => {
      const draft = await saveDraft(s, { ...manual(), modelUse: true });
      return previewDraft(s, { draftId: draft.id });
    };
    const runRow = (id: string) =>
      run((tx) => entity(tx, s, "knowledge_runs", id));
    const storedRuns = () => run((tx) => list(tx, s, "knowledge_runs"));
    const reservations = () =>
      run((tx) =>
        tx.budgetReservation.findMany({ where: { projectId: s.projectId } }),
      );
    const entityVersions = () =>
      run((tx) =>
        tx.entityVersion.count({ where: { projectId: s.projectId } }),
      );
    const openReservation = (state: "unknown" | "in_flight") =>
      run((tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key: `${s.projectId}:synthetic:${state}`,
            category: "knowledge_analysis",
            amountMicros: 10n,
            state,
          },
        }),
      );

    it("analysis routes through knowledge_analysis", async () => {
      const { job } = await paidSource();
      vi.mocked(planCall).mockClear();
      vi.mocked(respond).mockResolvedValue(answer([]) as any);
      expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
      expect(vi.mocked(planCall).mock.calls.map((c) => c[2])).toEqual([
        "knowledge_analysis",
      ]);
      expect((await reservations())[0]).toMatchObject({
        category: "knowledge_analysis",
        taskClass: "knowledge_analysis",
        model: "gpt-5.6-terra",
      });
    });
    it("gives a long answer room within the job's lease", async () => {
      const { job } = await paidSource();
      vi.mocked(respond).mockResolvedValue(answer([]) as any);
      await runAnalysis(s, job.id);
      expect(vi.mocked(respond).mock.calls[0]![0].timeoutMs).toBe(240000);
    });
    it("allows 13 proposals at the default", async () => {
      routeWith(12000);
      await spendPolicy();
      const { id: previewId } = await paidPreview();
      expect((await analysisPreflight(s, { previewId })).proposalLimit).toBe(
        13,
      );
      const job = await startAnalysis(s, {
        previewId,
        confirmModelUse: true,
      });
      vi.mocked(respond).mockResolvedValue(answer([]) as any);
      await runAnalysis(s, job.id);
      const request = vi.mocked(respond).mock.calls[0]![0];
      expect(request.instructions).toContain("Maximum 13 proposals");
      expect((request.outputSchema as any).properties.proposals.maxItems).toBe(
        13,
      );
      expect(data(await runRow(job.id)).outputDiagnostics).toMatchObject({
        maxOutputTokens: 12000,
        proposalLimit: 13,
      });
    });
    it("preflight reports a missing authority, model, price or open cost case without a reservation", async () => {
      const { id: previewId } = await paidPreview();
      const before = await entityVersions();
      const expectBlocked = async (blocker: string) => {
        const result = await analysisPreflight(s, { previewId });
        expect(result.ready).toBe(false);
        expect(result.blockers).toContain(blocker);
      };
      await expectBlocked("POLICY_REQUIRED");
      await spendPolicy();
      const afterPolicy = await entityVersions();
      expect(afterPolicy).toBe(before + 1);
      for (const code of [
        "MODEL_CAPABILITY_NOT_VERIFIED",
        "VERIFIED_PRICE_CONFIGURATION_REQUIRED",
        "CURRENT_PRICE_REQUIRED",
        "ROUTE_EFFORT_UNSUPPORTED",
      ]) {
        vi.mocked(planCall).mockRejectedValueOnce(new Error(code));
        const result = await analysisPreflight(s, { previewId });
        expect(result).toEqual({
          ready: false,
          blockers: [code],
          estimateMicros: 0,
          model: "",
          provider: "",
          proposalLimit: 0,
        });
      }
      delete process.env.OPENAI_API_KEY;
      await expectBlocked("KNOWLEDGE_MODEL_NOT_CONFIGURED");
      process.env.OPENAI_API_KEY = "synthetic-knowledge-key";
      expect(await reservations()).toHaveLength(0);
      expect(await storedRuns()).toHaveLength(0);
      expect(await entityVersions()).toBe(afterPolicy);
      await openReservation("in_flight");
      await expectBlocked("KNOWLEDGE_ANALYSIS_IN_PROGRESS");
      await run((tx) =>
        tx.budgetReservation.updateMany({
          where: { projectId: s.projectId },
          data: { state: "unknown" },
        }),
      );
      await expectBlocked("KNOWLEDGE_COST_UNKNOWN");
      expect(await reservations()).toHaveLength(1);
    });
    it("preflight reports what a reservation would refuse", async () => {
      const { id: previewId } = await paidPreview();
      const blockers = async () =>
        (await analysisPreflight(s, { previewId })).blockers;
      const policy = await spendPolicy({ perRunBudgetMicros: 99 });
      expect(await blockers()).toEqual(["BUDGET_NOT_APPROVED"]);
      await run((tx) =>
        update(tx, s, policy, { ...data(policy), active: false }),
      );
      const expired = await spendPolicy({
        endAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(await blockers()).toEqual(["PAID_MANDATE_EXPIRED"]);
      await run((tx) =>
        update(tx, s, expired, { ...data(expired), active: false }),
      );
      await spendPolicy({ dailyBudgetMicros: 150, perRunBudgetMicros: 150 });
      await run((tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            key: `${s.projectId}:synthetic:spent`,
            category: "other",
            amountMicros: 100n,
            settledMicros: 100n,
            state: "settled",
          },
        }),
      );
      expect(await blockers()).toEqual(["BUDGET_EXCEEDED"]);
    });
    it("start and preflight refuse the same way", async () => {
      await spendPolicy({ perRunBudgetMicros: 99 });
      const { id: previewId } = await paidPreview();
      expect((await analysisPreflight(s, { previewId })).blockers).toEqual([
        "BUDGET_NOT_APPROVED",
      ]);
      await expect(
        startAnalysis(s, { previewId, confirmModelUse: true }),
      ).rejects.toThrow("BUDGET_NOT_APPROVED");
      expect(await storedRuns()).toHaveLength(0);
    });
    it("preflight blocks a paused project", async () => {
      await spendPolicy();
      const { id: previewId } = await paidPreview();
      await authDb.project.update({
        where: { id: s.projectId },
        data: { paused: true },
      });
      expect((await analysisPreflight(s, { previewId })).blockers).toEqual([
        "PROJECT_PAUSED",
      ]);
    });
    it("preflight is ready and estimates when all is set", async () => {
      await spendPolicy();
      const { id: previewId } = await paidPreview();
      const before = await entityVersions();
      expect(await analysisPreflight(s, { previewId })).toEqual({
        ready: true,
        blockers: [],
        estimateMicros: 100,
        model: "gpt-5.6-terra",
        provider: "openai",
        proposalLimit: 3,
      });
      expect(await reservations()).toHaveLength(0);
      expect(await entityVersions()).toBe(before);
      const started = await startAnalysis(s, {
        previewId,
        confirmModelUse: true,
      });
      expect(data(started).status).toBe("queued");
    });
    it("preflight estimates exactly what the run reserves", async () => {
      const saved = {
        models: process.env.OPENAI_VERIFIED_MODELS,
        rates: process.env.OPENAI_RATE_CARD_JSON,
      };
      process.env.OPENAI_VERIFIED_MODELS = "gpt-5.6-terra";
      process.env.OPENAI_RATE_CARD_JSON = JSON.stringify({
        "gpt-5.6-terra": {
          inputMicrosPerMillion: 2_000_000,
          outputMicrosPerMillion: 10_000_000,
          verifiedAt: new Date().toISOString(),
        },
      });
      const route = { model: "gpt-5.6-terra", maxOutputTokens: 12000 };
      vi.mocked(planCall).mockImplementation(
        async (_tx, _s, _class, _runtime, estimate) => ({
          route,
          provider: "openai",
          estimateMicros: estimate(route),
          fallbackFrom: null,
        }),
      );
      try {
        await spendPolicy();
        const { id: previewId } = await paidPreview();
        const preflight = await analysisPreflight(s, { previewId });
        // The whole output ceiling is reserved, so the estimate follows it.
        expect(preflight.estimateMicros).toBeGreaterThan(120000);
        const job = await startAnalysis(s, {
          previewId,
          confirmModelUse: true,
        });
        vi.mocked(respond).mockResolvedValue(answer([]) as any);
        await runAnalysis(s, job.id);
        expect(Number((await reservations())[0]!.amountMicros)).toBe(
          preflight.estimateMicros,
        );
      } finally {
        if (saved.models === undefined)
          delete process.env.OPENAI_VERIFIED_MODELS;
        else process.env.OPENAI_VERIFIED_MODELS = saved.models;
        if (saved.rates === undefined) delete process.env.OPENAI_RATE_CARD_JSON;
        else process.env.OPENAI_RATE_CARD_JSON = saved.rates;
      }
    });
    it("preflight reports an expired preview and a run without AI as free", async () => {
      const draft = await saveDraft(s, manual());
      const preview = await previewDraft(s, { draftId: draft.id });
      expect(await analysisPreflight(s, { previewId: preview.id })).toEqual({
        ready: true,
        blockers: [],
        estimateMicros: 0,
        model: "",
        provider: "",
        proposalLimit: 1,
      });
      await saveDraft(s, {
        ...manual(),
        id: draft.id,
        version: draft.version,
        text: "Changed",
      });
      expect(
        (await analysisPreflight(s, { previewId: preview.id })).blockers,
      ).toEqual(["KNOWLEDGE_PREVIEW_EXPIRED"]);
    });
    it("preflight is owner-only and stays inside its project", async () => {
      const { id: previewId } = await paidPreview();
      const other = await authDb.project.create({
        data: { workspaceId, name: "Other" },
      });
      await expect(
        analysisPreflight({ ...s, projectId: other.id }, { previewId }),
      ).rejects.toThrow("NOT_FOUND");
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { role: "viewer" },
      });
      try {
        await expect(analysisPreflight(s, { previewId })).rejects.toThrow(
          "OWNER_REQUIRED",
        );
      } finally {
        await authDb.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId } },
          data: { role: "owner" },
        });
      }
    });
    const websitePreview = async (
      modelUse: boolean,
      address: { url: string; pages?: string[] } = {
        url: "https://help.example.invalid/docs",
      },
    ) => {
      const draft = await saveDraft(s, {
        ...manual(),
        kind: "website",
        text: "",
        ...address,
        modelUse,
      });
      return run((tx) =>
        create(tx, s, "knowledge_previews", {
          draftId: draft.id,
          draftVersion: draft.version,
          snapshot: {
            commit: null,
            files: [{ path: "/docs", text: "Hilfe", hash: hash("Hilfe") }],
            partial: false,
            skipped: 0,
          },
          expiresAt: Date.now() + HOUR,
        }),
      );
    };
    it("blocks a draft that may not use a model", async () => {
      await spendPolicy();
      const preview = await websitePreview(false);
      const result = await analysisPreflight(s, { previewId: preview.id });
      expect(result.blockers).toEqual(["MODEL_USE_FORBIDDEN"]);
      await expect(
        startAnalysis(s, { previewId: preview.id, confirmModelUse: true }),
      ).rejects.toThrow("MODEL_USE_FORBIDDEN");
    });
    const closedSource = (
      allowedPaths: string[],
      overrides: Record<string, unknown> = {},
    ) =>
      run((tx) =>
        create(tx, s, "sources", {
          name: "Andere",
          type: "website",
          status: "active",
          generation: 1,
          authority: "official",
          publicUse: false,
          modelUse: false,
          audiences: ["support"],
          maxAgeHours: 168,
          allowedOrigins: ["https://help.example.invalid"],
          allowedPaths,
          ...overrides,
        }),
      );
    it("blocks a page covered by a closed source under an uncovered root at preflight and start", async () => {
      await spendPolicy();
      await closedSource(["/private"]);
      const preview = await websitePreview(true, {
        url: "https://help.example.invalid/",
        pages: ["https://help.example.invalid/private/a"],
      });
      expect(
        (await analysisPreflight(s, { previewId: preview.id })).blockers,
      ).toEqual(["MODEL_USE_FORBIDDEN"]);
      await expect(
        startAnalysis(s, { previewId: preview.id, confirmModelUse: true }),
      ).rejects.toMatchObject({ code: "MODEL_USE_FORBIDDEN" });
      expect(await storedRuns()).toHaveLength(0);
    });
    it("does not send a page whose source was closed after the start", async () => {
      await spendPolicy();
      const preview = await websitePreview(true, {
        url: "https://help.example.invalid/",
        pages: ["https://help.example.invalid/private/a"],
      });
      const job = await startAnalysis(s, {
        previewId: preview.id,
        confirmModelUse: true,
      });
      await closedSource(["/private"]);
      vi.mocked(respond).mockResolvedValue(answer([]) as any);
      expect((await runAnalysis(s, job.id)).errorCode).toBe(
        "MODEL_USE_FORBIDDEN",
      );
      expect(respond).not.toHaveBeenCalled();
      expect(await reservations()).toHaveLength(0);
      expect(data(await runRow(job.id))).toMatchObject({
        status: "failed",
        error: "MODEL_USE_FORBIDDEN",
        costMicros: 0,
      });
      const draft = await run((tx) =>
        entity(tx, s, "knowledge_drafts", data(job).draftId),
      );
      expect(data(draft)).toMatchObject({
        activeRunId: null,
        status: "failed",
      });
    });
    it("blocks the address of a source that forbids model use", async () => {
      await spendPolicy();
      await closedSource(["/other"]);
      await closedSource(["/"], { allowedOrigins: [] });
      const source = await run((tx) =>
        create(tx, s, "sources", {
          name: "Hilfe",
          type: "website",
          status: "active",
          generation: 1,
          authority: "official",
          publicUse: false,
          modelUse: false,
          audiences: ["support"],
          maxAgeHours: 336,
          allowedOrigins: ["https://help.example.invalid"],
          allowedPaths: ["/docs"],
          site: {
            rootUrl: "https://help.example.invalid/docs",
            discovery: "sitemap",
            excludedPages: [],
            lastRunId: null,
          },
        }),
      );
      const preview = await websitePreview(true);
      expect(
        (await analysisPreflight(s, { previewId: preview.id })).blockers,
      ).toEqual(["MODEL_USE_FORBIDDEN"]);
      await run((tx) =>
        update(tx, s, source, { ...data(source), modelUse: true }),
      );
      expect(
        (await analysisPreflight(s, { previewId: preview.id })).blockers,
      ).toEqual([]);
    });
    it("start refuses an AI run without confirmModelUse", async () => {
      await spendPolicy();
      const { id: previewId } = await paidPreview();
      await expect(startAnalysis(s, { previewId })).rejects.toThrow(
        "MODEL_USE_FORBIDDEN",
      );
      expect(await storedRuns()).toHaveLength(0);
    });
    it("start records consent in the run", async () => {
      await spendPolicy();
      const { id: previewId } = await paidPreview();
      const started = await startAnalysis(s, {
        previewId,
        confirmModelUse: true,
      });
      expect(data(started).input.confirmModelUse).toBe(true);
      vi.mocked(respond).mockResolvedValue(answer([]) as any);
      expect((await runAnalysis(s, started.id)).status).toBe("succeeded");
    });
    it("a run without AI needs no consent", async () => {
      const { job } = await prepare();
      expect("confirmModelUse" in data(job).input).toBe(false);
      expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
    });
    it("a repeated AI run on unchanged text calls no model and needs no consent", async () => {
      const line = manual().text;
      const { job, draft } = await paidSource();
      vi.mocked(respond).mockResolvedValue(
        answer([
          {
            statement: "Shared calendars",
            topic: "features",
            stage: "documented",
            reason: "Claim",
            evidence: {
              path: "FamilyPlan docs",
              startLine: 1,
              endLine: 1,
              quote: line,
            },
          },
        ]) as any,
      );
      await runAnalysis(s, job.id);
      const preview = await previewDraft(s, { draftId: draft.id });
      expect(
        await analysisPreflight(s, { previewId: preview.id }),
      ).toMatchObject({ ready: true, estimateMicros: 0 });
      const next = await startAnalysis(s, { previewId: preview.id });
      await runAnalysis(s, next.id);
      expect(respond).toHaveBeenCalledTimes(1);
      expect(data(await runRow(next.id))).toMatchObject({
        status: "completed",
        costMicros: 0,
      });
    });
    it("a text without AI becomes one proposal", async () => {
      const text = "FamilyPlan organizes calendars.\n\nIt also plans meals.";
      const { job } = await prepare(
        knowledgeDraft.parse({ ...manual(), text }),
      );
      expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
      const rows = await proposals();
      expect(rows).toHaveLength(1);
      expect(data(rows[0])).toMatchObject({
        statement: text,
        evidence: { startLine: 1, endLine: 3, quote: text },
      });
      await approve(rows[0]);
      expect(respond).not.toHaveBeenCalled();
    });
    it("text over 1000 characters is refused with KNOWLEDGE_TEXT_TOO_LONG", async () => {
      const save = (text: string) =>
        saveDraft(s, knowledgeDraft.parse({ ...manual(), text }));
      const long = await save("x".repeat(1001));
      const preview = await previewDraft(s, { draftId: long.id });
      expect(
        await analysisPreflight(s, { previewId: preview.id }),
      ).toMatchObject({ ready: false, blockers: ["KNOWLEDGE_TEXT_TOO_LONG"] });
      await expect(
        startAnalysis(s, { previewId: preview.id }),
      ).rejects.toMatchObject({ code: "KNOWLEDGE_TEXT_TOO_LONG" });
      const file = { path: "text", text: "x".repeat(1001), hash: "h" };
      expect(() =>
        directTextProposals(manual(), {
          commit: null,
          files: [file],
          partial: false,
          skipped: 0,
        }),
      ).toThrow("KNOWLEDGE_TEXT_TOO_LONG");
      const fits = await save("x".repeat(1000));
      const allowed = await previewDraft(s, { draftId: fits.id });
      const job = await startAnalysis(s, { previewId: allowed.id });
      expect((await runAnalysis(s, job.id)).status).toBe("succeeded");
    });
    it("the run records costMicros", async () => {
      routeWith(3000, 150);
      const { job } = await paidSource();
      expect(data(await runRow(job.id)).costMicros).toBe(0);
      vi.mocked(respond).mockResolvedValue(answer([], 50) as any);
      await runAnalysis(s, job.id);
      expect(data(await runRow(job.id))).toMatchObject({
        status: "completed",
        costMicros: 50,
      });
    });
    it("a run without AI records no cost", async () => {
      const { job } = await prepare();
      await runAnalysis(s, job.id);
      expect(data(await runRow(job.id)).costMicros).toBe(0);
    });
    it("a cancelled run records what was settled", async () => {
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
      finish(answer([], 70));
      expect((await running).status).toBe("canceled");
      expect(data(await runRow(job.id))).toMatchObject({
        status: "canceled",
        costMicros: 70,
      });
    });
    it("a failed run records what was settled, or 0 when the cost is open", async () => {
      const first = await paidSource();
      vi.mocked(respond).mockResolvedValue({
        ...answer([], 60),
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "not json" }],
          },
        ],
      } as any);
      expect((await runAnalysis(s, first.job.id)).errorCode).toBe(
        "KNOWLEDGE_OUTPUT_INVALID",
      );
      expect(data(await runRow(first.job.id))).toMatchObject({
        status: "failed",
        costMicros: 60,
      });
      const second = await prepare({
        ...manual(),
        name: "Second",
        text: "Another text.",
        modelUse: true,
      });
      vi.mocked(respond).mockRejectedValue(new Error("Synthetic interruption"));
      expect((await runAnalysis(s, second.job.id)).errorCode).toBe(
        "KNOWLEDGE_COST_UNKNOWN",
      );
      expect(data(await runRow(second.job.id))).toMatchObject({
        status: "unknown",
        costMicros: 0,
      });
    });
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
    const { job } = await paidSource();
    delete process.env.OPENAI_API_KEY;
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
  describe("taking text over whole", () => {
    const accept = (extra: Record<string, unknown> = {}, as: Scope = s) =>
      (knowledgeActions["knowledge-content-accept"] as any).run({
        scope: as,
        input: {
          name: "Pricing sheet",
          text: "FamilyPlan organizes shared calendars for families.",
          kind: "manual",
          language: "de",
          marketing: true,
          support: false,
          publicUse: false,
          modelUse: true,
          ...extra,
        },
      }) as Promise<any>;
    const counts = () =>
      run(async (tx) => ({
        sources: await tx.entity.count({
          where: { projectId: s.projectId, kind: "sources" },
        }),
        documents: await tx.knowledgeDocument.count({
          where: { projectId: s.projectId },
        }),
      }));

    it("makes the whole text searchable under the chosen audiences", async () => {
      const source = await accept({ kind: "file" });
      const d = data(source);
      expect(d).toMatchObject({
        type: "file",
        status: "active",
        authority: "official",
        maxAgeHours: 8760,
        audiences: ["marketing"],
        modelUse: true,
        publicUse: false,
      });
      expect(await counts()).toEqual({ sources: 1, documents: 1 });
      expect((await search()).items).toHaveLength(1);
      const asSupport = data(
        await run((tx) =>
          retrieve(tx, s, {
            query: "FamilyPlan calendars",
            purpose: "internal",
            forModel: true,
            consumer: "support",
            language: "de",
          }),
        ),
      );
      expect(asSupport.items).toHaveLength(0);
      const audits = await run((tx) =>
        tx.auditEvent.findMany({
          where: {
            projectId: s.projectId,
            action: "knowledge.content_accepted",
          },
        }),
      );
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.metadata)).not.toContain("calendars");
      expect(vi.mocked(respond)).not.toHaveBeenCalled();
    });

    describe("what the assistants' search finds", () => {
      const QUERY = "FamilyPlan calendars";
      const found = async (consumer: string) =>
        (
          (await knowledgeSearch(s, { query: QUERY }, undefined, consumer))
            .result as { passages: unknown[] }
        ).passages.length;
      const publicText = {
        language: "en",
        publicUse: true,
        modelUse: true,
      };
      it("finds text for both audiences from both modules", async () => {
        await accept({ ...publicText, marketing: true, support: true });
        expect(await found("support")).toBe(1);
        expect(await found("marketing")).toBe(1);
      });
      it("finds support-only text from Support alone", async () => {
        await accept({ ...publicText, marketing: false, support: true });
        expect(await found("support")).toBe(1);
        expect(await found("marketing")).toBe(0);
      });
      it("hides text without the model right from model retrieval", async () => {
        await accept({ ...publicText, support: true, modelUse: false });
        expect(await found("support")).toBe(0);
        const notForModel = await run((tx) =>
          retrieve(tx, s, {
            query: QUERY,
            purpose: "public",
            consumer: "support",
            language: "en",
          }),
        );
        expect(data(notForModel).items).toHaveLength(1);
      });
      it("hides text without the public right from Support", async () => {
        await accept({ ...publicText, support: true, publicUse: false });
        expect(await found("support")).toBe(0);
      });
    });

    it("is refused when no audience is chosen", async () => {
      await expect(
        accept({ marketing: false, support: false }),
      ).rejects.toThrow("KNOWLEDGE_NO_AUDIENCE");
      expect(await counts()).toEqual({ sources: 0, documents: 0 });
    });

    it("refuses text with credentials", async () => {
      await expect(
        accept({
          text: "password = hunter2hunter2\napi_key: sk-live-abcdef0123456789abcdef",
        }),
      ).rejects.toThrow("KNOWLEDGE_SENSITIVE_TEXT_EXCLUDED");
      expect(await counts()).toEqual({ sources: 0, documents: 0 });
    });

    it("leaves no source behind when the text is refused", async () => {
      vi.mocked(ingest).mockRejectedValueOnce(
        new KnowledgeError("INVALID_DOCUMENT_SIZE"),
      );
      await expect(accept()).rejects.toThrow("INVALID_DOCUMENT_SIZE");
      expect(await counts()).toEqual({ sources: 0, documents: 0 });
    });

    describe("replacing the draft made on the way", () => {
      const draftData = (id: string) =>
        run(async (tx) => data(await entity(tx, s, "knowledge_drafts", id)));
      it("marks the draft replaced in the same step", async () => {
        const draft = await saveDraft(s, manual());
        await accept({ draftId: draft.id });
        expect((await draftData(draft.id)).status).toBe("replaced");
        expect(await counts()).toEqual({ sources: 1, documents: 1 });
      });
      it("leaves drafts alone without a draftId", async () => {
        const draft = await saveDraft(s, manual());
        await accept();
        expect((await draftData(draft.id)).status).toBe("draft");
      });
      it("keeps the draft when the take-over is refused", async () => {
        const draft = await saveDraft(s, manual());
        vi.mocked(ingest).mockRejectedValueOnce(
          new KnowledgeError("INVALID_DOCUMENT_SIZE"),
        );
        await expect(accept({ draftId: draft.id })).rejects.toThrow(
          "INVALID_DOCUMENT_SIZE",
        );
        expect((await draftData(draft.id)).status).toBe("draft");
        expect(await counts()).toEqual({ sources: 0, documents: 0 });
      });
      it("refuses a draft of another project", async () => {
        const other = await authDb.project.create({
          data: { workspaceId, name: "Synthetic other" },
        });
        const foreign = await scoped(workspaceId, other.id, (tx) =>
          create(tx, { ...s, projectId: other.id }, "knowledge_drafts", {
            input: manual(),
            status: "draft",
          }),
        );
        await expect(accept({ draftId: foreign.id })).rejects.toThrow();
        expect(await counts()).toEqual({ sources: 0, documents: 0 });
        const untouched = await scoped(workspaceId, other.id, (tx) =>
          entity(
            tx,
            { ...s, projectId: other.id },
            "knowledge_drafts",
            foreign.id,
          ),
        );
        expect(data(untouched).status).toBe("draft");
      });
      it("refuses a draft with an active run", async () => {
        const { draft } = await prepare();
        await expect(accept({ draftId: draft.id })).rejects.toThrow(
          "KNOWLEDGE_RUN_ACTIVE",
        );
        expect(await counts()).toEqual({ sources: 0, documents: 0 });
      });
    });

    it("only owners can use it", async () => {
      const permission =
        knowledgeActionPermissions["knowledge-content-accept"]!;
      expect(can({ role: "owner" }, permission)).toBe(true);
      expect(can({ role: "editor" }, permission)).toBe(false);
      expect(can({ role: "viewer" }, permission)).toBe(false);
      for (const as of [
        { ...s, userId: randomUUID(), role: "editor" as const },
        { ...s, userId: randomUUID(), role: "viewer" as const },
      ])
        await expect(accept({}, as)).rejects.toThrow("OWNER_REQUIRED");
      expect(await counts()).toEqual({ sources: 0, documents: 0 });
    });

    it("stays inside its project", async () => {
      await accept();
      const other = await authDb.project.create({
        data: { workspaceId, name: "Synthetic other" },
      });
      const [sources, documents] = await scoped(
        workspaceId,
        other.id,
        async (tx) => [
          await tx.entity.count({ where: { kind: "sources" } }),
          await tx.knowledgeDocument.count(),
        ],
      );
      expect({ sources, documents }).toEqual({ sources: 0, documents: 0 });
      expect(await counts()).toEqual({ sources: 1, documents: 1 });
    });
  });
});
