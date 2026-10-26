import { z } from "zod";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import { LINK_RELATIONS, OBJECT_TYPE } from "../../../../../packages/module-contracts/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { createLink, linksOf, linkTargets, removeLink } from "../../platform/links/links.ts";
import { ISSUE_TYPE, issuesMembers, userActor, uuid } from "./common.ts";
import { confirmCandidate, rejectCandidate } from "./duplicates.ts";
import { requireIssues } from "./gate.ts";
import { issueView, setIssueStatus, setShareReview, updateIssue } from "./issues.ts";
import { mergeIssue } from "./merge.ts";
import {
  ISSUES_READ,
  ISSUES_REPORT,
  ISSUES_SETTINGS,
  ISSUES_TRIAGE,
} from "./permissions.ts";
import { issueDetail, listIssues } from "./queries.ts";
import { readIssuesSettings, saveIssuesSettings } from "./settings.ts";
import { reportManually } from "./sources/manual.ts";
import { createSource, disableSource, listSources } from "./sources.ts";
import { issuesOverview } from "./stats.ts";

// The issue center's HTTP API (plan §4.2): a thin layer over the services.
// Every route checks the member's permission in the module, then that the
// module is on in the project (404 ISSUES_DISABLED), then runs in one
// project transaction.

const BASE = "/api/projects/:projectId/issues";

type Params = Record<string, string>;
type Req = Parameters<typeof scopeFor>[1];

export async function inIssues<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId!, required);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireIssues(tx, scope);
    return work(tx, scope, params);
  });
}

const id = (p: Params, key = "id") => uuid.parse(p[key]);
const settingsInput = z.object({ settings: z.unknown(), version: z.int().min(1) }).strict();
const linkInput = z
  .object({ targetType: z.string().regex(OBJECT_TYPE), targetId: uuid, relation: z.enum(LINK_RELATIONS) })
  .strict();
const targetsQuery = z.object({ type: z.string().regex(OBJECT_TYPE), q: z.string().max(200).default("") }).strict();

/** Issue center routes (plan §4.2). */
export const issuesRoutes: RoutesContribution = (context) => {
  const { app, auth } = context;
  app.get(`${BASE}/overview`, (req) => inIssues(auth, req, ISSUES_READ, (tx, scope) => issuesOverview(tx, scope)));
  app.get(`${BASE}/list`, (req) => inIssues(auth, req, ISSUES_READ, (tx, scope) => listIssues(tx, scope, req.query ?? {})));
  app.get(`${BASE}/members`, (req) =>
    inIssues(auth, req, ISSUES_READ, async (_tx, scope) => ({ items: await issuesMembers(scope) })),
  );
  app.get(`${BASE}/settings`, (req) => inIssues(auth, req, ISSUES_READ, (tx, scope) => readIssuesSettings(tx, scope)));
  app.put(`${BASE}/settings`, (req) =>
    inIssues(auth, req, ISSUES_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return saveIssuesSettings(tx, scope, settings, version);
    }),
  );

  // Reports: a new issue or a report on a chosen issue (intake, §2.4).
  app.post(`${BASE}/issues`, (req) =>
    inIssues(auth, req, ISSUES_REPORT, (tx, scope) => reportManually(tx, scope, req.body, userActor(scope))),
  );
  app.post(`${BASE}/issues/:id/reports`, (req) =>
    inIssues(auth, req, ISSUES_REPORT, (tx, scope, p) =>
      reportManually(tx, scope, { ...(req.body as object), issueId: id(p) }, userActor(scope)),
    ),
  );

  // Issues.
  app.get(`${BASE}/issues/:id`, (req) => inIssues(auth, req, ISSUES_READ, (tx, scope, p) => issueDetail(tx, scope, id(p))));
  app.patch(`${BASE}/issues/:id`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => issueView(await updateIssue(tx, scope, id(p), req.body, userActor(scope)))),
  );
  app.post(`${BASE}/issues/:id/status`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => issueView(await setIssueStatus(tx, scope, id(p), req.body, userActor(scope)))),
  );
  app.post(`${BASE}/issues/:id/merge`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => {
      const result = await mergeIssue(tx, scope, id(p), req.body, userActor(scope));
      return { issue: issueView(result.source), targetId: result.targetId, reports: result.reports, links: result.links };
    }),
  );
  app.post(`${BASE}/issues/:id/share-review`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => issueView(await setShareReview(tx, scope, id(p), req.body, userActor(scope)))),
  );

  // Duplicate candidates: a person confirms (merges) or rejects (I-3).
  app.post(`${BASE}/duplicates/:id/confirm`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => {
      const result = await confirmCandidate(tx, scope, id(p), req.body, userActor(scope));
      return { issue: issueView(result.source), targetId: result.targetId };
    }),
  );
  app.post(`${BASE}/duplicates/:id/reject`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, (tx, scope, p) => rejectCandidate(tx, scope, id(p), userActor(scope))),
  );

  // Links to tasks, tickets and other objects (ADR 0016).
  app.get(`${BASE}/issues/:id/links`, (req) =>
    inIssues(auth, req, ISSUES_READ, async (tx, scope, p) => ({ items: await linksOf(tx, scope, { type: ISSUE_TYPE, id: id(p) }) })),
  );
  app.post(`${BASE}/issues/:id/links`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => {
      const input = linkInput.parse(req.body);
      // A task implements the issue; other objects relate to it.
      const outgoing = !(input.relation === "implements" && input.targetType === "work.task");
      const issue = { type: ISSUE_TYPE, id: id(p) };
      const other = { type: input.targetType, id: input.targetId };
      const row = await createLink(
        tx,
        scope,
        { source: outgoing ? issue : other, target: outgoing ? other : issue, relation: input.relation },
        userActor(scope),
      );
      return { id: row.id };
    }),
  );
  app.delete(`${BASE}/links/:id`, (req) =>
    inIssues(auth, req, ISSUES_TRIAGE, async (tx, scope, p) => {
      await removeLink(tx, scope, id(p), userActor(scope), "issues");
      return { id: id(p), deleted: true };
    }),
  );
  app.get(`${BASE}/link-targets`, (req) =>
    inIssues(auth, req, ISSUES_READ, async (tx, scope) => {
      const q = targetsQuery.parse(req.query ?? {});
      return { items: await linkTargets(tx, scope, q.type, q.q) };
    }),
  );

  // Inbound sources (webhook, n8n): the secret is returned once.
  app.get(`${BASE}/sources`, (req) => inIssues(auth, req, ISSUES_SETTINGS, async (tx, scope) => ({ items: await listSources(tx, scope) })));
  app.post(`${BASE}/sources`, (req) => inIssues(auth, req, ISSUES_SETTINGS, (tx, scope) => createSource(tx, scope, req.body)));
  app.delete(`${BASE}/sources/:id`, (req) => inIssues(auth, req, ISSUES_SETTINGS, (tx, scope, p) => disableSource(tx, scope, id(p))));
};
