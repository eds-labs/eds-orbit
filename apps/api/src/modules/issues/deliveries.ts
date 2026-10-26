import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { audit, DomainError } from "../../shared.ts";
import { issueDomainEvent, issueEvent, uuid, type IssueActor } from "./common.ts";
import { loadIssue, setIssueStatus } from "./issues.ts";
import { deliveryView } from "./queries.ts";
import { readIssuesSettings } from "./settings.ts";

// Delivery records (ADR 0018, plan §2.7, WP3.11): what happened to a fix.
// `pr_merged` is not a release; `deployed` names its environment, and only
// a production environment can release an issue (S4, in sync.ts). In the
// MVP a person records them; GitHub and deployment webhooks come later
// (WP3.10). Records are append-only.

const recordInput = z
  .object({
    kind: z.enum(["pr_opened", "pr_merged", "checks", "deployed", "verified"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).optional(),
    prNumber: z.int().min(1).optional(),
    commitSha: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
    environment: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/).optional(),
    status: z.enum(["success", "failure"]).optional(),
    observedAt: z.coerce.date().optional(),
  })
  .strict()
  .refine((d) => d.kind !== "deployed" || d.environment, "a deployment names its environment");

/** Records a delivery and publishes `issues.delivery.recorded` for the sync rules. */
export async function recordDelivery(tx: DbTx, scope: Scope, id: string, raw: unknown, actor: IssueActor) {
  const input = recordInput.parse(raw);
  const issue = await loadIssue(tx, scope, uuid.parse(id));
  if (issue.status === "duplicate") throw new DomainError("ISSUES_ISSUE_MERGED", 409);
  // A person confirms a release only for a released issue (I-6).
  if (input.kind === "verified" && issue.status !== "released") throw new DomainError("ISSUES_NOT_RELEASED", 409);
  const { settings } = await readIssuesSettings(tx, scope);
  const production = input.kind === "deployed" && settings.productionEnvironments.includes(input.environment!);
  const now = new Date();
  const row = await tx.issueDelivery.create({
    data: {
      id: randomUUID(),
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      issueId: issue.id,
      kind: input.kind,
      repository: input.repository,
      prNumber: input.prNumber,
      commitSha: input.commitSha,
      environment: input.environment,
      source: "manual",
      status: input.status,
      observedAt: input.observedAt && input.observedAt < now ? input.observedAt : now,
      recordedBy: actor.id,
    },
  });
  await issueEvent(tx, scope, issue.id, "delivery", actor, {}, { deliveryId: row.id, kind: row.kind, environment: row.environment, production });
  await audit(tx, scope, "issues.delivery.recorded", row.id, { issueId: issue.id, kind: row.kind, production });
  await issueDomainEvent(tx, scope, "issues.delivery.recorded", { type: "issues.delivery", id: row.id }, actor, {
    issueId: issue.id,
    kind: row.kind,
    environment: row.environment,
    production,
  });
  // A person's verification is the issue's next status (released -> verified).
  if (input.kind === "verified")
    await setIssueStatus(tx, scope, issue.id, { status: "verified", expectedVersion: issue.version, reason: "verified" }, actor);
  return deliveryView(row);
}

/** The releases view: fix-ready and released issues with their latest record per environment. */
export async function releasesView(tx: DbTx, scope: Scope) {
  const issues = await tx.issue.findMany({
    where: { projectId: scope.projectId, status: { in: ["fix_ready", "released"] } },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    take: 200,
  });
  const deliveries = await tx.issueDelivery.findMany({
    where: { projectId: scope.projectId, issueId: { in: issues.map((i) => i.id) } },
    orderBy: { observedAt: "desc" },
  });
  const { settings } = await readIssuesSettings(tx, scope);
  return {
    productionEnvironments: settings.productionEnvironments,
    items: issues.map((i) => {
      const own = deliveries.filter((d) => d.issueId === i.id);
      const environments = new Map<string, (typeof own)[number]>();
      for (const d of own) if (d.kind === "deployed" && d.environment && !environments.has(d.environment)) environments.set(d.environment, d);
      return {
        id: i.id,
        key: `ISS-${i.number}`,
        title: i.title,
        status: i.status,
        severity: i.severity,
        merged: own.some((d) => d.kind === "pr_merged"),
        deployments: [...environments.values()].map(deliveryView),
        lastRecord: own[0] ? deliveryView(own[0]) : null,
      };
    }),
  };
}
