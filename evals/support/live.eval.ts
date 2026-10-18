import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase, scoped } from "../../packages/db/src/index.ts";
import type { Scope } from "../../packages/schemas/src/index.ts";
import { estimateCost, respond } from "../../packages/ai/src/index.ts";
import { create } from "../../apps/api/src/shared.ts";
import { saveOpenAiConfiguration } from "../../apps/api/src/platform/ai/openai-configuration.ts";
import { writeModuleSettings } from "../../apps/api/src/platform/modules/settings.ts";
import { createInbox } from "../../apps/api/src/modules/support/inboxes.ts";
import { createTicket } from "../../apps/api/src/modules/support/tickets.ts";
import { runSupportTask } from "../../apps/api/src/modules/support/ai.ts";
import {
  supportSettingsDefaults,
  supportSettingsSchema,
} from "../../apps/api/src/modules/support/settings.ts";
import { assertLocalDatabase } from "../generation/harness.ts";
import { resolveLiveKey } from "../agents/eval-key.ts";
import { callBytes, plan, renderPlan, usd } from "./live-plan.ts";

// The paid eval of the support AI (WP5.6), approved by Mario on 2026-10-17
// with a hard cap of 3 USD. Only the model calls are real: retrieval returns
// each case's synthetic evidence. Synthetic data, a local database and a
// project created and deleted per run. The report holds ids and numbers
// only, never message text or the key.

const evidence = vi.hoisted(() => ({ current: null as unknown }));
vi.mock(
  "../../apps/api/src/platform/knowledge/search.ts",
  async (original) => ({
    ...(await original<
      typeof import("../../apps/api/src/platform/knowledge/search.ts")
    >()),
    knowledgeSearch: vi.fn(async () => ({
      result: evidence.current,
      cards: [],
    })),
  }),
);
vi.mock("../../packages/knowledge/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../packages/knowledge/src/index.ts")>()),
  validateEvidence: vi.fn(async () => ({ valid: true, reasons: [] })),
}));

const EVIDENCE_ID = "22222222-2222-4222-8222-222222222222";

describe("support AI live eval", () => {
  it("measures triage and drafts within the ceiling", async () => {
    const p = plan();
    console.log(renderPlan(p));
    if (!process.env.ORBIT_EVAL_CONFIRM) return; // dry run
    assertLocalDatabase();
    if (vi.isMockFunction(respond)) throw new Error("EVAL_RESPOND_STUBBED");
    const apiKey = await resolveLiveKey(process.env, p.confirmation);
    process.env.ORBIT_SUPPORT = "true";

    const user = await authDb.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic support eval",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic support eval",
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic support eval" },
    });
    const owner: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId: user.id,
      role: "owner",
    };
    const worker = { ...owner, userId: "worker" };
    const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
      scoped(owner.workspaceId, owner.projectId, fn);
    const spent = async () =>
      (
        await run((tx) =>
          tx.budgetReservation.findMany({
            where: { projectId: owner.projectId },
          }),
        )
      ).reduce((s, r) => s + Number(r.settledMicros ?? r.amountMicros), 0);
    const report = {
      dataset: p.set.version,
      hash: p.hash,
      routes: p.routes,
      ceilingMicros: p.maxCostMicros,
      commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      startedAt: new Date().toISOString(),
      triage: [] as Array<Record<string, unknown>>,
      drafts: [] as Array<Record<string, unknown>>,
      stoppedAtCeiling: false,
      costMicros: 0,
    };
    try {
      const now = new Date();
      await run(async (tx) => {
        await create(tx, owner, "policies", {
          mode: "observe",
          channels: [],
          contentTypes: ["social"],
          allowedOrigins: [],
          startAt: new Date(now.getTime() - 3600_000).toISOString(),
          endAt: new Date(now.getTime() + 86_400_000).toISOString(),
          maxPerDay: 1,
          minIntervalMinutes: 1,
          // The platform enforces the same ceiling again.
          dailyBudgetMicros: p.maxCostMicros,
          monthlyBudgetMicros: p.maxCostMicros,
          perRunBudgetMicros: p.maxCostMicros,
          approvedPaidTests: true,
          active: true,
        });
        const models = [p.routes.triage.model, p.routes.draft.model];
        await saveOpenAiConfiguration(tx, owner, {
          apiKey,
          verifiedModels: [...new Set(models)],
          rateCard: Object.fromEntries(
            [...new Set(models)].map((m) => [
              m,
              { ...p.rateCard[m]!, verifiedAt: new Date().toISOString() },
            ]),
          ),
          modelRoutes: {
            fast: p.routes.triage.model,
            standard: p.routes.triage.model,
            quality: p.routes.draft.model,
            escalation: p.routes.draft.model,
          },
          taskRoutes: {
            support_triage: p.routes.triage,
            support_draft: p.routes.draft,
          },
        });
        await tx.projectModule.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            moduleId: "support",
            enabled: true,
            moduleVersion: "1.0.0",
          },
        });
        await writeModuleSettings(
          tx,
          owner,
          "support",
          supportSettingsSchema,
          {
            ...supportSettingsDefaults(),
            categories: p.set.categories.map((key) => ({ key, label: key })),
          },
          1,
        );
      });
      const inboxId = await run(
        async (tx) =>
          (
            await createInbox(tx, owner, {
              name: "Eval",
              channels: ["email"],
              emailAddress: "eval@example.invalid",
              aiMode: "draft",
            })
          ).inbox.id,
      );
      const ticket = (text: string) =>
        run((tx) =>
          createTicket(tx, owner, {
            inboxId,
            channel: "email",
            inbound: {
              externalId: null,
              contact: {
                email: `${randomUUID()}@example.org`,
                name: "Synthetic Customer",
              },
              subject: "Eval",
              bodyText: text,
              attachments: [],
            },
          }),
        );
      /** Refuses a call that could pass the ceiling. */
      const guard = async (model: string, bytes: number, maxOut: number) => {
        const next = estimateCost(model, bytes, maxOut, {
          rateCard: p.rateCard,
        });
        if ((await spent()) + next > p.maxCostMicros) {
          report.stoppedAtCeiling = true;
          return false;
        }
        return true;
      };

      for (const c of p.set.triage) {
        if (
          !(await guard(
            p.routes.triage.model,
            callBytes(c.text),
            p.routes.triage.maxOutputTokens,
          ))
        )
          break;
        const t = await ticket(c.text);
        let error: string | null = null;
        try {
          await runSupportTask(worker, {
            task: "triage",
            ticketId: t.ticketId,
          });
        } catch (e) {
          error = (e as { code?: string }).code ?? "ERROR";
        }
        const event = await run((tx) =>
          tx.supportTicketEvent.findFirst({
            where: { ticketId: t.ticketId, type: "ai_triage" },
          }),
        );
        const after = (event?.after ?? {}) as {
          category?: string;
          language?: string;
          sensitive?: boolean;
        };
        report.triage.push({
          id: c.id,
          error,
          category: after.category === c.category,
          language: String(after.language ?? "")
            .toLowerCase()
            .startsWith(c.language),
          sensitiveExpected: c.sensitive,
          sensitiveFlagged: after.sensitive === true,
        });
      }
      for (const c of p.set.drafts) {
        if (report.stoppedAtCeiling) break;
        const bytes = callBytes(
          c.text,
          Buffer.byteLength(JSON.stringify([c.facts, c.passages])),
        );
        if (
          !(await guard(
            p.routes.draft.model,
            bytes,
            p.routes.draft.maxOutputTokens,
          ))
        )
          break;
        evidence.current = {
          status: "ready",
          retrieval: { mode: "hybrid", evidenceId: EVIDENCE_ID },
          facts: c.facts.map((f) => ({ ...f, version: 1, sourceId: "s" })),
          passages: c.passages.map((x) => ({
            ...x,
            sourceId: "s",
            url: "https://example.invalid",
          })),
          gaps: [],
        };
        const t = await ticket(c.text);
        let error: string | null = null;
        try {
          await runSupportTask(worker, { task: "draft", ticketId: t.ticketId });
        } catch (e) {
          error = (e as { code?: string }).code ?? "ERROR";
        }
        const [row, draftEvent, withheld] = await run((tx) =>
          Promise.all([
            tx.supportTicket.findUniqueOrThrow({ where: { id: t.ticketId } }),
            tx.supportTicketEvent.findFirst({
              where: { ticketId: t.ticketId, type: "ai_draft" },
            }),
            tx.supportTicketEvent.findFirst({
              where: { ticketId: t.ticketId, type: "ai_draft_withheld" },
            }),
          ]),
        );
        const problems =
          ((withheld?.after ?? {}) as { problems?: string[] }).problems ?? [];
        const citations = Number(
          ((draftEvent?.after ?? {}) as { citations?: number }).citations ?? 0,
        );
        report.drafts.push({
          id: c.id,
          expect: c.expect,
          error,
          drafted: Boolean(draftEvent),
          citations,
          handedOff: row.aiState === "handed_off",
          withheld: problems,
          forbidden: problems.some((x) => x.startsWith("forbidden")),
        });
      }
    } finally {
      report.costMicros = await spent().catch(() => -1);
      await authDb.workspace
        .delete({ where: { id: workspace.id } })
        .catch(() => undefined);
      await authDb.user
        .delete({ where: { id: user.id } })
        .catch(() => undefined);
      delete process.env.ORBIT_SUPPORT;
    }

    const triage = report.triage;
    const answers = report.drafts.filter((d) => d.expect === "answer");
    const handoffs = report.drafts.filter((d) => d.expect === "handoff");
    const metrics = {
      triageCategory: `${triage.filter((t) => t.category).length}/${p.set.triage.length}`,
      triageLanguage: `${triage.filter((t) => t.language).length}/${p.set.triage.length}`,
      sensitiveRecall: `${triage.filter((t) => t.sensitiveExpected && t.sensitiveFlagged).length}/${p.set.triage.filter((t) => t.sensitive).length}`,
      answeredWithCitations: `${answers.filter((d) => d.drafted && Number(d.citations) > 0).length}/${p.set.drafts.filter((d) => d.expect === "answer").length}`,
      handedOffWhenUnanswerable: `${handoffs.filter((d) => d.handedOff).length}/${p.set.drafts.filter((d) => d.expect === "handoff").length}`,
      forbiddenContent: report.drafts.filter((d) => d.forbidden).length,
      errors: [...triage, ...report.drafts].filter((x) => x.error).length,
    };
    const count = (s: string) => Number(s.split("/")[0]);
    const pass =
      !report.stoppedAtCeiling &&
      metrics.errors === 0 &&
      count(metrics.triageCategory) >= 10 &&
      count(metrics.triageLanguage) >= 11 &&
      count(metrics.sensitiveRecall) ===
        p.set.triage.filter((t) => t.sensitive).length &&
      count(metrics.answeredWithCitations) >= 5 &&
      count(metrics.handedOffWhenUnanswerable) ===
        p.set.drafts.filter((d) => d.expect === "handoff").length &&
      metrics.forbiddenContent === 0;
    const result = {
      ...report,
      metrics,
      pass,
      cost: usd(report.costMicros),
      finishedAt: new Date().toISOString(),
    };
    mkdirSync("docs/evidence", { recursive: true });
    const file = `docs/evidence/support-ai-eval-${result.finishedAt.slice(0, 10)}.json`;
    writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
    console.log(
      `${pass ? "PASS" : "FAIL"} ${JSON.stringify(metrics)} cost ${result.cost} -> ${file}`,
    );
    expect(JSON.stringify(result)).not.toContain(apiKey);
    await closeDatabase();
  });
});
