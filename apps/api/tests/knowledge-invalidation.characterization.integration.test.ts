import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  ingest,
  revokeDocument,
  revokeSource,
  setFact,
  setSourceRights,
  withdrawFact,
} from "../../../packages/knowledge/src/index.ts";
import { create } from "../src/shared.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Characterization (WP0.4, plans/orbit-modularization/05 §4): what the
 * knowledge engine's invalidate() does to marketing state at each of its
 * eight call sites. Work package WP3.1 moves the marketing part into an
 * impact handler; these snapshots must stay unchanged by that move.
 * Every scenario runs on a fresh project with the same fixture.
 */
const PUBLICATION_STATUSES = [
  "scheduled",
  "sending",
  "outcome_unknown",
  "scheduled_remote",
  "published",
  "reconciliation_required",
  "cancellation_required",
  "published_test",
  "cancelled",
  "canceled",
  "deleted",
];
const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/g;
const DAY = 86400000;

type Fixture = {
  scope: Scope;
  sourceId: string;
  factId: string;
  documentId: string;
  labels: Map<string, string>;
};

describe.skipIf(!enabled)(
  "Knowledge invalidation cascade (characterization)",
  () => {
    const users: string[] = [];
    const workspaces: string[] = [];
    const past = new Date(Date.now() - DAY).toISOString();
    const future = new Date(Date.now() + 30 * DAY).toISOString();
    const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
      scoped(s.workspaceId, s.projectId, fn);

    async function fixture(): Promise<Fixture> {
      const userId = randomUUID();
      await authDb.user.create({
        data: {
          id: userId,
          name: "Synthetic invalidation owner",
          email: `${randomUUID()}@example.invalid`,
        },
      });
      users.push(userId);
      const workspace = await authDb.workspace.create({
        data: {
          name: "Synthetic invalidation",
          members: { create: { userId, role: "owner" } },
        },
      });
      workspaces.push(workspace.id);
      const project = await authDb.project.create({
        data: {
          workspaceId: workspace.id,
          name: "Synthetic invalidation project",
        },
      });
      const scope: Scope = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId,
        role: "owner",
      };
      const labels = new Map<string, string>();
      const make = async (
        tx: DbTx,
        kind: string,
        label: string,
        value: Record<string, unknown>,
      ) => {
        const row = await create(tx, scope, kind, { label, ...value });
        labels.set(row.id, label);
        return row.id;
      };
      return run(scope, async (tx) => {
        const sourceValue = {
          status: "active",
          generation: 1,
          publicUse: true,
          modelUse: true,
          authority: "official",
          maxAgeHours: 168,
          allowedOrigins: [],
          allowedPaths: ["/"],
        };
        const sourceId = await make(tx, "sources", "source", {
          name: "Synthetic source",
          ...sourceValue,
        });
        const otherSourceId = await make(tx, "sources", "source-other", {
          name: "Synthetic other source",
          ...sourceValue,
        });
        await ingest(tx, scope, {
          sourceId,
          externalId: "guide",
          title: "Guide",
          text: "Synthetic guide, first version.",
          mimeType: "text/plain",
          language: "en",
          expectedGeneration: 1,
        });
        const documentId = (
          await tx.knowledgeDocument.findFirstOrThrow({ where: { sourceId } })
        ).id;
        labels.set(documentId, "document");
        const fact = await setFact(tx, scope, {
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
          modelUse: true,
        });
        labels.set(fact.id, "fact");
        const evidence = {
          status: "ready",
          query: "synthetic",
          gaps: [],
        };
        const e1 = await make(tx, "evidence", "evidence-source-item", {
          ...evidence,
          items: [{ sourceId, chunkId: randomUUID(), text: "x" }],
          facts: [],
        });
        const e2 = await make(tx, "evidence", "evidence-fact-only", {
          ...evidence,
          items: [],
          facts: [{ id: fact.id, sourceId, key: "price", value: "19" }],
        });
        const e3 = await make(tx, "evidence", "evidence-unrelated", {
          ...evidence,
          items: [
            { sourceId: otherSourceId, chunkId: randomUUID(), text: "x" },
          ],
          facts: [],
        });
        const body = {
          status: "approved",
          title: "Title",
          text: "Body",
          body: "Body",
          claims: [{ text: "claim" }],
          subject: "Subject",
          altText: "Alt",
        };
        const c1 = await make(tx, "content", "content-evidence-source-item", {
          ...body,
          evidenceId: e1,
        });
        const c2 = await make(tx, "content", "content-evidence-fact-only", {
          ...body,
          evidenceId: e2,
        });
        const c3 = await make(tx, "content", "content-unrelated", {
          ...body,
          evidenceId: e3,
        });
        await make(tx, "approvals", "approval-content-1", {
          status: "approved",
          resourceId: c1,
        });
        await make(tx, "approvals", "approval-content-2", {
          status: "approved",
          contentId: c2,
        });
        await make(tx, "approvals", "approval-unrelated", {
          status: "approved",
          resourceId: c3,
        });
        for (const status of PUBLICATION_STATUSES)
          await make(tx, "publications", `publication-${status}`, {
            status,
            contentId: c1,
          });
        await make(tx, "publications", "publication-unrelated", {
          status: "sending",
          contentId: c3,
        });
        await make(tx, "insights", "insight-source", {
          status: "active",
          sourceIds: [sourceId],
          summary: "s",
          rationale: "r",
        });
        await make(tx, "insights", "insight-evidence", {
          status: "active",
          evidenceId: e2,
          summary: "s",
        });
        await make(tx, "insights", "insight-unrelated", {
          status: "active",
          sourceIds: [otherSourceId],
          summary: "s",
        });
        await make(tx, "jobs", "job-content-queued", {
          topic: "generation",
          status: "queued",
          resourceId: c1,
        });
        await make(tx, "jobs", "job-content-completed", {
          topic: "generation",
          status: "completed",
          resourceId: c1,
        });
        await make(tx, "jobs", "job-source-queued", {
          topic: "ingestion",
          status: "queued",
          resourceId: sourceId,
        });
        await make(tx, "jobs", "job-evidence-queued", {
          topic: "generation",
          status: "queued",
          resourceId: e1,
        });
        await make(tx, "jobs", "job-unrelated", {
          topic: "generation",
          status: "queued",
          resourceId: c3,
        });
        return { scope, sourceId, factId: fact.id, documentId, labels };
      });
    }

    /** The project's state with ids replaced by fixture labels. */
    async function state(f: Fixture) {
      const name = (value: unknown) =>
        JSON.parse(
          JSON.stringify(value ?? null).replace(UUID, (id) =>
            f.labels.has(id) ? `<${f.labels.get(id)}>` : "<new>",
          ),
        );
      return run(f.scope, async (tx) => {
        const entities = await tx.entity.findMany({
          where: {
            workspaceId: f.scope.workspaceId,
            projectId: f.scope.projectId,
          },
          include: { _count: { select: { versions: true } } },
        });
        const rows = entities
          .map((e) => {
            const d = e.data as Record<string, unknown>;
            return name({
              kind: e.kind,
              label:
                d.label ??
                (e.kind === "facts" ? `fact ${d.key}=${d.value}` : null),
              version: e.version,
              storedVersions: e._count.versions,
              status: d.status ?? null,
              ...(d.invalidationReason
                ? { invalidationReason: d.invalidationReason }
                : {}),
              ...(d.dependencyInvalidated
                ? { dependencyInvalidated: true }
                : {}),
              ...(d.reconciliationStatus
                ? { reconciliationStatus: d.reconciliationStatus }
                : {}),
              ...(d.reviewReason ? { reviewReason: d.reviewReason } : {}),
              ...(e.kind === "evidence"
                ? {
                    gaps: d.gaps,
                    items: (d.items as unknown[])?.length,
                    facts: (d.facts as unknown[])?.length,
                    query: d.query,
                  }
                : {}),
              ...(["content", "insights"].includes(e.kind)
                ? {
                    title: d.title ?? null,
                    text: d.text ?? null,
                    claims: d.claims ?? null,
                  }
                : {}),
              ...(e.kind === "sources"
                ? {
                    generation: d.generation,
                    publicUse: d.publicUse,
                    modelUse: d.modelUse,
                  }
                : {}),
              ...(e.kind === "jobs"
                ? {
                    topic: d.topic,
                    resourceId: d.resourceId,
                    idempotencyKey: d.idempotencyKey ?? null,
                    reason: d.reason ?? null,
                  }
                : {}),
            });
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const outbox = (
          await tx.outbox.findMany({
            where: {
              workspaceId: f.scope.workspaceId,
              projectId: f.scope.projectId,
            },
          })
        )
          .map((o) => {
            const job = entities.find((e) => e.id === o.entityId);
            return name({
              topic: o.topic,
              job: job
                ? ((job.data as Record<string, unknown>).label ??
                  (job.data as Record<string, unknown>).idempotencyKey)
                : null,
            });
          })
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const documents = await tx.knowledgeDocument.findMany({
          where: {
            workspaceId: f.scope.workspaceId,
            projectId: f.scope.projectId,
          },
          include: { versions: { select: { state: true } } },
        });
        return {
          entities: rows,
          outbox,
          documents: documents.map((d) => ({
            active: Boolean(d.activeVersionId),
            versions: d.versions.map((v) => v.state).sort(),
          })),
        };
      });
    }

    const factInput = (f: Fixture, value: string) => ({
      key: "price",
      value,
      valueType: "decimal" as const,
      currency: "EUR",
      language: "en" as const,
      sourceId: f.sourceId,
      validFrom: past,
      validUntil: future,
      status: "verified" as const,
      publicUse: true,
      modelUse: true,
    });

    const scenarios: Record<
      string,
      (tx: DbTx, f: Fixture) => Promise<unknown>
    > = {
      "ingest of a changed document (source_changed)": (tx, f) =>
        ingest(tx, f.scope, {
          sourceId: f.sourceId,
          externalId: "guide",
          title: "Guide",
          text: "Synthetic guide, second version.",
          mimeType: "text/plain",
          language: "en",
        }),
      "fact change (fact_changed)": (tx, f) =>
        setFact(tx, f.scope, { ...factInput(f, "21"), id: f.factId }),
      "fact supersession (fact_superseded, fact_changed)": (tx, f) =>
        setFact(tx, f.scope, { ...factInput(f, "21"), supersedesId: f.factId }),
      "conflicting fact (fact_conflict, fact_changed)": (tx, f) =>
        setFact(tx, f.scope, factInput(f, "22")),
      "fact withdrawal (fact_revoked)": async (tx, f) =>
        withdrawFact(
          tx,
          f.scope,
          f.factId,
          (await tx.entity.findUniqueOrThrow({ where: { id: f.factId } }))
            .version,
        ),
      "source revocation with purge (source_revoked)": (tx, f) =>
        revokeSource(tx, f.scope, f.sourceId),
      "source rights change (source_permissions_changed)": (tx, f) =>
        setSourceRights(tx, f.scope, f.sourceId, { publicUse: false }),
      "document revocation with purge (document_revoked)": (tx, f) =>
        revokeDocument(tx, f.scope, f.documentId),
    };

    afterAll(async () => {
      await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
      await authDb.user.deleteMany({ where: { id: { in: users } } });
      await closeDatabase();
    });

    it("starts every scenario from the same fixture", async () => {
      expect(await state(await fixture())).toMatchSnapshot();
    });

    it.each(Object.keys(scenarios))("%s", async (scenario) => {
      const f = await fixture();
      await run(f.scope, (tx) => scenarios[scenario]!(tx, f));
      expect(await state(f)).toMatchSnapshot();
    });
  },
);
