import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { registerModules } from "../src/modules/registry.ts";
import { availableTools, exposedToMcp } from "../src/platform/agents/tools/registry.ts";
import { registeredTools } from "../src/platform/modules/contributions.ts";
import { workContributions } from "../src/modules/work/contributions.ts";
import { createInitiative } from "../src/modules/work/initiatives.ts";
import { setPmState } from "../src/modules/work/pm/state.ts";
import { workPmRequestPlan, workPmStatus } from "../src/modules/work/pm/tools.ts";
import { createWorkPmProject, withEnv } from "./support/work-pm-project.ts";

registerModules();

vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async () => {
    throw new Error("NO_MODEL_CALL_EXPECTED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const READS = ["work_pm_findings", "work_pm_get_plan", "work_pm_get_report", "work_pm_status"];
const REQUESTS = ["work_pm_request_plan", "work_pm_request_report"];

describe("AI project manager assistant tools (WP2.6)", () => {
  const env = withEnv({ ORBIT_WORK: "true" });
  beforeAll(() => env.apply());
  afterAll(() => env.restore());
  const pm = (role: "owner" | "editor" | "viewer", features: Parameters<typeof availableTools>[2]) =>
    availableTools(registeredTools(), role, features)
      .map((t) => t.name)
      .filter((n) => n.startsWith("work_pm_"))
      .sort();

  it("offers reads to every member and requests to editors, only with the PM's feature", () => {
    expect(pm("editor", ["work", "work_pm"])).toEqual([...READS, ...REQUESTS].sort());
    expect(pm("viewer", ["work", "work_pm"])).toEqual(READS);
    expect(pm("owner", ["work"])).toEqual([]);
    // Spending requests are for the member in the app, never for outside clients.
    for (const tool of registeredTools().filter((t) => REQUESTS.includes(t.name))) expect(exposedToMcp(tool)).toBe(false);
    for (const tool of registeredTools().filter((t) => READS.includes(t.name))) {
      expect(exposedToMcp(tool)).toBe(true);
      expect(tool.mcpScopes).toEqual(["orbit:work"]);
    }
  });

  it("adds its feature and prompt only while ORBIT_WORK_PM is on", () => {
    const assistant = workContributions.assistant!;
    expect(assistant.features({ toolSearch: true })).toEqual(["work"]);
    expect(assistant.instructions({ toolSearch: true }).join(" ")).not.toContain("work_pm_");
    process.env.ORBIT_WORK_PM = "true";
    try {
      expect(assistant.features({ toolSearch: true })).toEqual(["work", "work_pm"]);
      expect(assistant.instructions({ toolSearch: true }).join(" ")).toContain("work_pm_request_plan");
    } finally {
      delete process.env.ORBIT_WORK_PM;
    }
    // The size bound counts every fragment.
    expect(assistant.instructions({ toolSearch: true, all: true }).join(" ")).toContain("work_pm_request_plan");
  });
});

describe.skipIf(!enabled)("AI project manager assistant tools in a project", () => {
  let p: Awaited<ReturnType<typeof createWorkPmProject>>;
  const env = withEnv({ ORBIT_WORK: "true", ORBIT_WORK_PM: "true" });
  const context = (scope: typeof p.owner) => ({ scope, runId: "run-1", conversationId: "conversation-1", callIndex: 1 });

  beforeAll(async () => {
    env.apply();
    p = await createWorkPmProject();
    const initiative = await p.run((tx) => createInitiative(tx, p.owner, { title: "Launch", key: "LAUNCH" }, p.as(p.owner)));
    await p.run((tx) => setPmState(tx, p.owner, initiative.id, { expectedVersion: 0, enabled: true }));
  });
  afterAll(async () => {
    env.restore();
    await p?.cleanup();
    await closeDatabase();
  });

  it("starts planning for the member once per tool call", async () => {
    const args = { goal: "Plan the launch", constraints: null, initiativeKey: null };
    const first = await workPmRequestPlan.execute(context(p.editor), args);
    expect(first.output).toMatchObject({ status: "queued", deduplicated: false });
    expect(first.cards).toEqual([{ kind: "status", label: "Planning started", status: "in_progress" }]);
    const again = await workPmRequestPlan.execute(context(p.editor), args);
    expect(again.output).toMatchObject({ planId: (first.output as { planId: string }).planId, deduplicated: true });
    const row = await p.run((tx) => tx.workPlanProposal.findFirstOrThrow({ where: { id: (first.output as { planId: string }).planId } }));
    expect(row).toMatchObject({ requestedBy: p.editor.userId, requestedVia: "assistant" });
    await expect(workPmRequestPlan.execute(context(p.viewer), args)).rejects.toThrow();
  });

  it("reads the PM status of an initiative by key", async () => {
    const result = await workPmStatus.execute(context(p.viewer), { initiativeKey: "launch" });
    expect((result.output as { result: unknown }).result).toMatchObject({
      initiative: { key: "LAUNCH" },
      watching: true,
      findings: { critical: 0, warning: 0, info: 0 },
      budget: { spentMicros: 0, ceilingMicros: 2_000_000 },
    });
  });
});
