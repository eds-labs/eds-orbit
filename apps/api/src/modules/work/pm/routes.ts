import { z } from "zod";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../../platform/http/routes.ts";
import type { Auth } from "../../../platform/tenancy/auth.ts";
import { scopeFor } from "../../../platform/tenancy/auth.ts";
import { uuid } from "../common.ts";
import { pmActive, requirePm, requireWork } from "../gate.ts";
import {
  WORK_PM_MANAGE,
  WORK_PM_USE,
  WORK_READ,
  WORK_WRITE,
} from "../permissions.ts";
import { pmBudgetToday } from "./budget.ts";
import {
  discardPlan,
  listProposals,
  loadProposal,
  proposalView,
  requestPlan,
  retryPlan,
  revisePlan,
} from "./planner.ts";
import { readPmSettings, savePmSettings } from "./settings.ts";
import { dismissFinding, listFindings } from "./monitor.ts";
import { requestAnalysis } from "./analyst.ts";
import { listReports, loadReport, requestReport } from "./reporter.ts";
import { handoffView, listHandoffs, proposeHandoff } from "./handoffs.ts";
import {
  cancelCodingRun,
  codingRunView,
  createCodingRun,
  editCodingBrief,
  listCodingRuns,
  loadCodingRun,
  reportManualRun,
  submitCodingRun,
} from "./coding.ts";
import { availableHandoffs } from "../../../platform/handoffs/handoffs.ts";
import { getPmState, setPmState } from "./state.ts";

// The AI project manager's HTTP API (plan §4.3), under the work module's
// base path. Every route but `status` answers 404 WORK_PM_DISABLED while
// ORBIT_WORK_PM is off or the module is off in the project.

const BASE = "/api/projects/:projectId/work/pm";

type Params = Record<string, string>;
type Req = Parameters<typeof scopeFor>[1];

async function inPm<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requirePm(tx, scope);
    return work(tx, scope, params);
  });
}

const id = (p: Params, key = "id") => uuid.parse(p[key]);
const settingsInput = z.object({ settings: z.unknown(), version: z.int().min(1) }).strict();
const findingsQuery = z
  .object({ initiativeId: uuid.optional(), status: z.enum(["open", "resolved", "dismissed"]).optional() })
  .strict();
const initiativeInput = z.object({ initiativeId: uuid }).strict();
const reportsQuery = z.object({ initiativeId: uuid.optional() }).strict();
const codingQuery = z.object({ taskId: uuid.optional() }).strict();
const plansQuery = z
  .object({ initiativeId: uuid.optional(), open: z.enum(["true", "false"]).optional() })
  .strict();

export const pmRoutes: RoutesContribution = ({ app, auth }) => {
  // Whether the PM is available here, for the web; also while it is off.
  app.get(`${BASE}/status`, async (req) => {
    const params = req.params as Params;
    const scope = await scopeFor(auth, req, params.projectId!, WORK_READ);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      await requireWork(tx, scope);
      if (!(await pmActive(tx, scope))) return { available: false };
      return { available: true, budget: await pmBudgetToday(tx, scope) };
    });
  });
  app.get(`${BASE}/settings`, (req) =>
    inPm(auth, req, WORK_PM_USE, (tx, scope) => readPmSettings(tx, scope)),
  );
  app.put(`${BASE}/settings`, (req) =>
    inPm(auth, req, WORK_PM_MANAGE, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return savePmSettings(tx, scope, settings, version);
    }),
  );
  app.get(`${BASE}/initiatives/:id/state`, (req) =>
    inPm(auth, req, WORK_READ, (tx, scope, p) => getPmState(tx, scope, id(p))),
  );
  app.put(`${BASE}/initiatives/:id/state`, (req) =>
    inPm(auth, req, WORK_PM_MANAGE, (tx, scope, p) => setPmState(tx, scope, id(p), req.body)),
  );

  // Findings of the monitor.
  app.get(`${BASE}/findings`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope) => ({
      items: await listFindings(tx, scope, findingsQuery.parse(req.query ?? {})),
    })),
  );
  app.post(`${BASE}/findings/:id/dismiss`, (req) =>
    inPm(auth, req, WORK_WRITE, (tx, scope, p) => dismissFinding(tx, scope, id(p), req.body)),
  );

  // Reports and analyses.
  app.post(`${BASE}/reports`, (req) =>
    inPm(auth, req, WORK_PM_USE, (tx, scope) =>
      requestReport(tx, scope, initiativeInput.parse(req.body).initiativeId),
    ),
  );
  app.get(`${BASE}/reports`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope) => ({
      items: await listReports(tx, scope, reportsQuery.parse(req.query ?? {}).initiativeId),
    })),
  );
  app.get(`${BASE}/reports/:id`, (req) =>
    inPm(auth, req, WORK_READ, (tx, scope, p) => loadReport(tx, scope, id(p))),
  );
  app.post(`${BASE}/analyses`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope) => {
      const result = await requestAnalysis(tx, scope, initiativeInput.parse(req.body).initiativeId);
      return { ...proposalView(result!.proposal), deduplicated: result!.deduplicated };
    }),
  );

  // Handoffs of tasks (ADR 0017 P-3).
  app.get(`${BASE}/handoff-targets`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope) => ({ items: await availableHandoffs(tx, scope, "work.task") })),
  );
  app.get(`${BASE}/tasks/:id/handoffs`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope, p) => ({ items: await listHandoffs(tx, scope, id(p)) })),
  );
  app.post(`${BASE}/tasks/:id/handoffs`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => handoffView(await proposeHandoff(tx, scope, id(p), req.body))),
  );

  // Coding work orders (ADR 0017 P-4).
  app.post(`${BASE}/tasks/:id/coding-runs`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => codingRunView(await createCodingRun(tx, scope, id(p), req.body))),
  );
  app.get(`${BASE}/coding-runs`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope) => ({
      items: await listCodingRuns(tx, scope, codingQuery.parse(req.query ?? {}).taskId),
    })),
  );
  app.get(`${BASE}/coding-runs/:id`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope, p) => codingRunView(await loadCodingRun(tx, scope, id(p)))),
  );
  app.patch(`${BASE}/coding-runs/:id`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => codingRunView(await editCodingBrief(tx, scope, id(p), req.body))),
  );
  app.post(`${BASE}/coding-runs/:id/submit`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => codingRunView(await submitCodingRun(tx, scope, id(p), req.body))),
  );
  app.post(`${BASE}/coding-runs/:id/cancel`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => codingRunView(await cancelCodingRun(tx, scope, id(p)))),
  );
  app.patch(`${BASE}/coding-runs/:id/manual`, (req) =>
    inPm(auth, req, WORK_WRITE, async (tx, scope, p) => codingRunView(await reportManualRun(tx, scope, id(p), req.body))),
  );

  // Plans.
  app.post(`${BASE}/plans`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope) => {
      const { proposal, deduplicated } = await requestPlan(tx, scope, req.body, "ui");
      return { ...proposalView(proposal), deduplicated };
    }),
  );
  app.get(`${BASE}/plans`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope) => {
      const q = plansQuery.parse(req.query ?? {});
      return { items: await listProposals(tx, scope, { initiativeId: q.initiativeId, open: q.open === "true" }) };
    }),
  );
  app.get(`${BASE}/plans/:id`, (req) =>
    inPm(auth, req, WORK_READ, async (tx, scope, p) => proposalView(await loadProposal(tx, scope, id(p)))),
  );
  app.post(`${BASE}/plans/:id/revisions`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => proposalView(await revisePlan(tx, scope, id(p), req.body))),
  );
  app.post(`${BASE}/plans/:id/retry`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => proposalView(await retryPlan(tx, scope, id(p)))),
  );
  app.post(`${BASE}/plans/:id/discard`, (req) =>
    inPm(auth, req, WORK_PM_USE, async (tx, scope, p) => proposalView(await discardPlan(tx, scope, id(p)))),
  );
};
