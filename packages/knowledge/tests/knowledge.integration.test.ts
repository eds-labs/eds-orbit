import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, scoped, type PrismaClient } from "@orbit/db";
import {
  ingest,
  retrieve,
  setFact,
  revokeSource,
  withdrawFact,
  setSourceRights,
  revokeDocument,
  validateEvidence,
  attachEmbeddings,
  EMBEDDING_PROFILE,
  type Scope,
  type EvidenceData,
} from "../src/index.js";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const dataset = JSON.parse(
  readFileSync(
    new URL("../../../evals/knowledge/deterministic-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  version: string;
  cases: Array<{
    id: string;
    category: string;
    language: string;
    documentId: string;
    title: string;
    text: string;
    query: string;
    expected: string;
    relevantDocument?: string;
  }>;
};
const suite = enabled ? describe : describe.skip;
suite("PostgreSQL pgvector knowledge / nonprivileged RLS", () => {
  let app: PrismaClient, auth: PrismaClient;
  let a: Scope, b: Scope, c: Scope;
  const fixtures = new Map<
    string,
    { sourceId: string; versionId: string; documentId: string }
  >();
  const timings: number[] = [];
  const contextEstimates: number[] = [];
  const outcomes: Array<{ id: string; category: string; rank: number }> = [];
  const at = new Date();
  const run = <T>(scope: Scope, fn: Parameters<typeof scoped<T>>[2]) =>
    scoped(scope.workspaceId, scope.projectId, fn, app);
  async function source(
    scope: Scope = a,
    overrides: Record<string, unknown> = {},
  ) {
    return run(scope, (tx) =>
      tx.entity.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "sources",
          data: {
            name: "Synthetic fixture source",
            type: "file",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: true,
            authority: "official",
            maxAgeHours: 720,
            allowedOrigins: [],
            allowedPaths: [],
            ...overrides,
          },
        },
      }),
    );
  }
  const input = (
    sourceId: string,
    text = "Atlas beta documentation with durable jobs.",
  ) => ({
    sourceId,
    externalId: randomUUID(),
    title: "Fixture",
    text,
    mimeType: "text/plain",
    language: "en",
    validFrom: new Date(at.getTime() - 3600000).toISOString(),
    expectedGeneration: 1,
  });
  beforeAll(async () => {
    app = createClient(process.env.TEST_DATABASE_URL!);
    auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
    const user = await auth.user.create({
      data: {
        id: randomUUID(),
        name: "Synthetic test owner",
        email: `${randomUUID()}@example.invalid`,
        emailVerified: false,
      },
    });
    const w1 = await auth.workspace.create({
        data: { name: "Synthetic knowledge A" },
      }),
      w2 = await auth.workspace.create({
        data: { name: "Synthetic knowledge B" },
      });
    await auth.workspaceMember.createMany({
      data: [
        { workspaceId: w1.id, userId: user.id, role: "owner" },
        { workspaceId: w2.id, userId: user.id, role: "owner" },
      ],
    });
    const p1 = await auth.project.create({
        data: { workspaceId: w1.id, name: "A" },
      }),
      p2 = await auth.project.create({
        data: { workspaceId: w1.id, name: "B" },
      }),
      p3 = await auth.project.create({
        data: { workspaceId: w2.id, name: "C" },
      });
    a = { workspaceId: w1.id, projectId: p1.id, userId: user.id };
    b = { ...a, projectId: p2.id };
    c = { workspaceId: w2.id, projectId: p3.id, userId: user.id };
    for (const test of dataset.cases) {
      if (fixtures.has(test.documentId)) continue;
      const target = test.category === "cross_project" ? b : a;
      const src = await source(target, {
        publicUse: test.category !== "internal",
        modelUse: test.category !== "model_forbidden",
        authority: test.category === "generated" ? "generated" : "official",
        ...(test.category === "embargo"
          ? { embargoUntil: new Date(at.getTime() + 3600000).toISOString() }
          : {}),
      });
      const doc = await run(target, (tx) =>
        ingest(tx, target, {
          ...input(src.id, test.text),
          title: test.title,
          externalId: test.documentId,
          language: test.language,
          ...(test.category === "expired"
            ? {
                validFrom: new Date(at.getTime() - 7200000).toISOString(),
                validUntil: new Date(at.getTime() - 3600000).toISOString(),
              }
            : {}),
          ...(test.category === "future"
            ? { validFrom: new Date(at.getTime() + 3600000).toISOString() }
            : {}),
        }),
      );
      fixtures.set(test.documentId, {
        sourceId: src.id,
        versionId: doc.versionId,
        documentId: doc.documentId,
      });
      if (test.category === "revoked")
        await run(target, (tx) => revokeSource(tx, target, src.id));
    }
  }, 120000);
  afterAll(async () => {
    if (timings.length) {
      const sorted = [...timings].sort((x, y) => x - y);
      let commit = "UNCOMMITTED_LOCAL_WORKTREE";
      try {
        commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        /* New local repository has no commit yet. */
      }
      const sourceHash = createHash("sha256");
      for (const file of [
        "../src/index.ts",
        "../src/types.ts",
        "../src/algorithms.ts",
        "../src/indexes.ts",
        "../../db/prisma/migrations/202609170001_foundation/migration.sql",
        "../../db/prisma/migrations/202609170002_index_generations/migration.sql",
      ])
        sourceHash.update(readFileSync(new URL(file, import.meta.url)));
      writeFileSync(
        new URL(
          "../../../evals/knowledge/last-deterministic-run.json",
          import.meta.url,
        ),
        JSON.stringify(
          {
            datasetVersion: dataset.version,
            datasetSha256: createHash("sha256")
              .update(
                readFileSync(
                  new URL(
                    "../../../evals/knowledge/deterministic-v1.json",
                    import.meta.url,
                  ),
                ),
              )
              .digest("hex"),
            sourceSha256: sourceHash.digest("hex"),
            commit,
            runtime: process.version,
            retrieverVersion: "hybrid-rrf-v1",
            chunkingVersion: "structure-v1",
            contextTokenEstimateMax: Math.max(...contextEstimates),
            executedAt: new Date().toISOString(),
            environment: "isolated PostgreSQL 17 / pgvector exact baseline",
            cases: dataset.cases.length,
            observedQueries: timings.length,
            p50Ms: sorted[Math.floor(sorted.length * 0.5)],
            p95Ms: sorted[Math.floor(sorted.length * 0.95)],
            providerCostMicros: 0,
            liveSemanticEvaluation: false,
            indexProfile: EMBEDDING_PROFILE,
            status:
              outcomes.length === dataset.cases.length ? "PASS_TEST" : "FAIL",
            passedCases: outcomes.length,
            lexicalRecallAt8:
              outcomes.filter((r) => r.category === "lexical" && r.rank > 0)
                .length / 48,
            lexicalMrr:
              outcomes
                .filter((r) => r.category === "lexical")
                .reduce((n, r) => n + (r.rank ? 1 / r.rank : 0), 0) / 48,
            negativePassed: outcomes.filter((r) => r.category !== "lexical")
              .length,
          },
          null,
          2,
        ) + "\n",
      );
    }
    // Synthetic test records intentionally persist in the isolated database for inspection.
    await app?.$disconnect();
    await auth?.$disconnect();
  });
  it.each(dataset.cases)("eval $id", async (test) => {
    const start = performance.now();
    const evidence = await run(a, (tx) =>
      retrieve(tx, a, {
        query: test.query,
        purpose: "public",
        language: test.language,
        at,
        forModel: test.category === "model_forbidden",
      }),
    );
    timings.push(Math.round(performance.now() - start));
    const data = evidence.data as unknown as EvidenceData;
    contextEstimates.push(
      Math.ceil(
        JSON.stringify({
          facts: data.facts,
          items: data.items.map((i) => ({ title: i.title, text: i.text })),
        }).length / 3,
      ),
    );
    const fixture = fixtures.get(test.documentId)!;
    if (test.expected === "source") {
      expect(data.status).toBe("ready");
      expect(data.items.map((i) => i.documentVersionId)).toContain(
        fixture.versionId,
      );
      expect(
        data.items.every(
          (i) => i.sourceId !== fixtures.get("internal-en")?.sourceId,
        ),
      ).toBe(true);
    } else {
      expect(data.items.map((i) => i.documentVersionId)).not.toContain(
        fixture.versionId,
      );
      expect(data.status).toBe("insufficient_evidence");
    }
    outcomes.push({
      id: test.id,
      category: test.category,
      rank:
        data.items.findIndex((i) => i.documentVersionId === fixture.versionId) +
        1,
    });
  });
  it("uses nonowner nonsuperuser nonbypass app role", async () => {
    const role = await app.$queryRaw<
      Array<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }>
    >`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role[0]?.rolsuper).toBe(false);
    expect(role[0]?.rolbypassrls).toBe(false);
    expect(role[0]?.current_user).toBe("orbit_app");
    const owners = await app.$queryRaw<
      Array<{ owned: boolean }>
    >`SELECT tableowner=current_user AS owned FROM pg_tables WHERE tablename='KnowledgeChunk'`;
    expect(owners[0]?.owned).toBe(false);
  });
  it("forbids unscoped access and pooled project leakage", async () => {
    expect(await app.entity.findMany()).toEqual([]);
    for (let i = 0; i < 8; i++) {
      const target = i % 2 ? a : b;
      const rows = await run(target, (tx) => tx.entity.findMany());
      expect(
        rows.every(
          (r) =>
            r.projectId === target.projectId &&
            r.workspaceId === target.workspaceId,
        ),
      ).toBe(true);
    }
    expect(await app.entity.findMany()).toEqual([]);
    expect(await run(c, (tx) => tx.entity.findMany())).toEqual([]);
  });
  it("denies forged tenant inserts", async () => {
    await expect(
      run(a, (tx) =>
        tx.entity.create({
          data: {
            workspaceId: b.workspaceId,
            projectId: b.projectId,
            kind: "facts",
            data: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it("denies cross-project source foreign keys", async () => {
    const src = await source(b);
    await expect(
      run(a, (tx) =>
        tx.knowledgeDocument.create({
          data: {
            workspaceId: a.workspaceId,
            projectId: a.projectId,
            sourceId: src.id,
            externalId: "forbidden",
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it("deduplicates unchanged import and leaves complete version after failed embedding batch", async () => {
    const src = await source();
    const data = input(src.id);
    const first = await run(a, (tx) => ingest(tx, a, data));
    const same = await run(a, (tx) => ingest(tx, a, data));
    expect(same.unchanged).toBe(true);
    expect(same.versionId).toBe(first.versionId);
    await expect(
      run(a, (tx) =>
        ingest(tx, a, { ...data, text: "Changed text", embeddings: [] }),
      ),
    ).rejects.toThrow("INCOMPLETE_EMBEDDINGS");
    const doc = await run(a, (tx) =>
      tx.knowledgeDocument.findUnique({ where: { id: first.documentId } }),
    );
    expect(doc?.activeVersionId).toBe(first.versionId);
  });
  it("title and validity changes create versions and invalidate prior evidence", async () => {
    const src = await source();
    const data = {
      ...input(src.id, "Metadata version regression reference"),
      title: "TITLEORIGINAL918",
    };
    const first = await run(a, (tx) => ingest(tx, a, data));
    const evidence = await run(a, (tx) =>
      retrieve(tx, a, {
        query: data.title,
        sourceIds: [src.id],
        purpose: "public",
        at,
      }),
    );
    expect(
      (evidence.data as unknown as EvidenceData).items[0]?.documentVersionId,
    ).toBe(first.versionId);
    const titled = await run(a, (tx) =>
      ingest(tx, a, { ...data, title: "TITLEREVISED918" }),
    );
    expect(titled.unchanged).toBe(false);
    expect(titled.versionId).not.toBe(first.versionId);
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, evidence.id, at))).valid,
    ).toBe(false);
    const revised = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "TITLEREVISED918",
        sourceIds: [src.id],
        purpose: "public",
        at,
      }),
    );
    expect((revised.data as unknown as EvidenceData).items[0]?.title).toBe(
      "TITLEREVISED918",
    );
    const expired = await run(a, (tx) =>
      ingest(tx, a, {
        ...data,
        title: "TITLEREVISED918",
        validUntil: new Date(at.getTime() - 1000).toISOString(),
      }),
    );
    expect(expired.versionId).not.toBe(titled.versionId);
    const absent = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "TITLEREVISED918",
        sourceIds: [src.id],
        purpose: "public",
        at,
      }),
    );
    expect((absent.data as unknown as EvidenceData).items).toHaveLength(0);
    const versions = await run(a, (tx) =>
      tx.documentVersion.findMany({
        where: { documentId: first.documentId },
        orderBy: { version: "asc" },
      }),
    );
    expect(versions.map((v) => v.state)).toEqual([
      "superseded",
      "superseded",
      "active",
    ]);
  });
  it("mandatory source set restricts both vector and lexical results and reports missing required sources", async () => {
    const src = await source(),
      other = await source();
    const vector = Array(1536).fill(0);
    vector[2] = 1;
    await run(a, (tx) =>
      ingest(tx, a, {
        ...input(src.id, "MANDATORY621 chosen source"),
        embeddings: [vector],
      }),
    );
    await run(a, (tx) =>
      ingest(tx, a, {
        ...input(other.id, "MANDATORY621 alternative source"),
        embeddings: [vector],
      }),
    );
    const e = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "MANDATORY621",
        sourceIds: [src.id],
        queryVector: vector,
        purpose: "public",
        at,
      }),
    );
    expect(
      (e.data as unknown as EvidenceData).items.map((i) => i.sourceId),
    ).toEqual([src.id]);
    await run(a, (tx) => setSourceRights(tx, a, src.id, { paused: true }));
    const denied = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "MANDATORY621",
        sourceIds: [src.id],
        queryVector: vector,
        purpose: "public",
        at,
      }),
    );
    expect((denied.data as unknown as EvidenceData).items).toHaveLength(0);
    expect((denied.data as unknown as EvidenceData).gaps).toContain(
      "required_source_unavailable:" + src.id,
    );
  });
  it("retrieves lexical plus real pgvector SQL with explicit synthetic test vectors", async () => {
    const src = await source();
    const vector = Array(1536).fill(0);
    vector[0] = 1;
    const imported = await run(a, (tx) =>
      ingest(tx, a, {
        ...input(
          src.id,
          "ZEPHYR471 hybrid search combines semantic and lexical ranking.",
        ),
        embeddings: [vector],
      }),
    );
    const e = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "ZEPHYR471",
        purpose: "public",
        queryVector: vector,
        at,
      }),
    );
    const d = e.data as unknown as EvidenceData;
    expect(d.mode).toBe("hybrid");
    expect(
      d.items.find((i) => i.documentVersionId === imported.versionId)?.reasons,
    ).toEqual(["lexical", "semantic"]);
    await expect(
      run(a, (tx) =>
        retrieve(tx, a, {
          query: "x",
          purpose: "public",
          queryVector: vector,
          profile: "large:3072",
        }),
      ),
    ).rejects.toThrow("UNSUPPORTED_EMBEDDING_PROFILE");
  });
  it("facts win over generated content and conflicts block evidence", async () => {
    const src = await source();
    const factBase = {
      key: "atlas.price",
      value: "12.00",
      valueType: "decimal" as const,
      currency: "EUR",
      language: "en",
      sourceId: src.id,
      validFrom: new Date(at.getTime() - 3600000).toISOString(),
      status: "verified" as const,
      publicUse: true,
      modelUse: true,
    };
    const f = await run(a, (tx) => setFact(tx, a, factBase));
    const e = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "atlas.price",
        factKeys: ["atlas.price"],
        purpose: "public",
        at,
      }),
    );
    expect((e.data as unknown as EvidenceData).facts[0]?.value).toBe("12.00");
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, e.id, at))).valid,
    ).toBe(true);
    await run(a, (tx) => setFact(tx, a, { ...factBase, value: "99.00" }));
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, e.id, at))).valid,
    ).toBe(false);
    const conflict = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "atlas.price",
        factKeys: ["atlas.price"],
        purpose: "public",
        at,
      }),
    );
    expect((conflict.data as unknown as EvidenceData).gaps).toContain(
      "conflicting_fact:atlas.price",
    );
    expect(f.id).toBeTruthy();
  });
  it("K05: facts honor timezone-equivalent half-open intervals and execution-time expiry", async () => {
    const src = await source();
    const base = {
      key: "boundary.price",
      value: "10",
      valueType: "decimal" as const,
      currency: "EUR",
      language: "en",
      sourceId: src.id,
      status: "verified" as const,
      publicUse: true,
      modelUse: true,
    };
    await run(a, (tx) =>
      setFact(tx, a, {
        ...base,
        validFrom: "2030-03-31T00:00:00Z",
        validUntil: "2030-03-31T03:00:00+02:00",
      }),
    );
    await run(a, (tx) =>
      setFact(tx, a, {
        ...base,
        value: "20",
        validFrom: "2030-03-31T01:00:00Z",
        validUntil: "2030-04-01T00:00:00Z",
      }),
    );
    const before = await run(a, (tx) =>
      retrieve(tx, a, {
        query: base.key,
        factKeys: [base.key],
        sourceIds: [src.id],
        purpose: "public",
        at: "2030-03-31T00:59:59Z",
      }),
    );
    expect(
      (before.data as unknown as EvidenceData).facts.map((f) => f.value),
    ).toEqual(["10"]);
    const boundary = await run(a, (tx) =>
      retrieve(tx, a, {
        query: base.key,
        factKeys: [base.key],
        sourceIds: [src.id],
        purpose: "public",
        at: "2030-03-31T01:00:00Z",
      }),
    );
    expect(
      (boundary.data as unknown as EvidenceData).facts.map((f) => f.value),
    ).toEqual(["20"]);
    expect(
      (
        await run(a, (tx) =>
          validateEvidence(tx, a, before.id, "2030-03-31T01:00:00Z"),
        )
      ).reasons,
    ).toContain("fact_changed_or_expired");
    const expired = await run(a, (tx) =>
      retrieve(tx, a, {
        query: base.key,
        factKeys: [base.key],
        sourceIds: [src.id],
        purpose: "public",
        at: "2030-04-01T00:00:00Z",
      }),
    );
    expect((expired.data as unknown as EvidenceData).facts).toHaveLength(0);
  });
  it("resolves a complete conflict group atomically and preserves predecessor identities", async () => {
    const src = await source();
    const base = {
      key: "resolved.capacity",
      value: "10",
      valueType: "decimal" as const,
      unit: "seats",
      language: "en",
      sourceId: src.id,
      validFrom: new Date(at.getTime() - 3600000).toISOString(),
      status: "verified" as const,
      publicUse: true,
      modelUse: true,
    };
    const first = await run(a, (tx) => setFact(tx, a, base));
    const second = await run(a, (tx) =>
      setFact(tx, a, { ...base, value: "20" }),
    );
    const third = await run(a, (tx) =>
      setFact(tx, a, { ...base, value: "30" }),
    );
    await expect(
      run(a, (tx) =>
        setFact(tx, a, {
          ...base,
          value: "40",
          resolveConflictIds: [first.id, second.id],
        }),
      ),
    ).rejects.toThrow("INCOMPLETE_CONFLICT_RESOLUTION");
    await expect(
      run(a, (tx) =>
        setFact(tx, a, {
          ...base,
          value: "40",
          status: "candidate",
          resolveConflictIds: [first.id, second.id, third.id],
        }),
      ),
    ).rejects.toThrow("INCOMPLETE_CONFLICT_RESOLUTION");
    const corrected = await run(a, (tx) =>
      setFact(tx, a, {
        ...base,
        value: "40",
        resolveConflictIds: [first.id, second.id, third.id],
      }),
    );
    const prior = await run(a, (tx) =>
      tx.entity.findMany({
        where: { id: { in: [first.id, second.id, third.id] } },
      }),
    );
    expect(prior.map((f) => (f.data as { status: string }).status)).toEqual([
      "superseded",
      "superseded",
      "superseded",
    ]);
    expect(
      await run(a, (tx) =>
        tx.entityVersion.count({
          where: { entityId: { in: [first.id, second.id, third.id] } },
        }),
      ),
    ).toBeGreaterThanOrEqual(3);
    const e = await run(a, (tx) =>
      retrieve(tx, a, {
        query: base.key,
        factKeys: [base.key],
        purpose: "public",
        at,
      }),
    );
    expect(
      (e.data as unknown as EvidenceData).facts.map((f) => [f.id, f.value]),
    ).toEqual([[corrected.id, "40"]]);
    expect((e.data as unknown as EvidenceData).status).toBe("ready");
  });
  it("revocation queues a worker-readable reconciliation job for uncertain publication", async () => {
    const src = await source();
    await run(a, (tx) => ingest(tx, a, input(src.id, "RECONCILE682 source")));
    const evidence = await run(a, (tx) =>
      retrieve(tx, a, { query: "RECONCILE682", purpose: "public", at }),
    );
    const publication = await run(a, async (tx) => {
      const content = await tx.entity.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          kind: "content",
          data: {
            evidenceId: evidence.id,
            status: "approved",
            text: "Dependent draft",
          },
        },
      });
      return tx.entity.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          kind: "publications",
          data: {
            contentId: content.id,
            status: "outcome_unknown",
            idempotencyKey: "fixture-uncertain",
          },
        },
      });
    });
    await run(a, (tx) => revokeSource(tx, a, src.id));
    const jobs = await run(a, (tx) =>
      tx.entity.findMany({
        where: {
          kind: "jobs",
          data: { path: ["resourceId"], equals: publication.id },
        },
      }),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({
      topic: "reconciliation",
      resourceId: publication.id,
      status: "queued",
    });
    const outbox = await run(a, (tx) =>
      tx.outbox.findMany({ where: { entityId: jobs[0]!.id } }),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      topic: "reconciliation",
      payload: { jobId: jobs[0]!.id },
    });
    expect(
      (
        await run(a, (tx) =>
          tx.entity.findUniqueOrThrow({ where: { id: publication.id } }),
        )
      ).data,
    ).toMatchObject({ status: "reconciliation_required" });
  });
  it("preserves terminal execution receipts while flagging invalidated dependencies", async () => {
    const src = await source();
    const publications = await run(a, async (tx) =>
      Promise.all(
        ["published_test", "published", "canceled"].map((status) =>
          tx.entity.create({
            data: {
              workspaceId: a.workspaceId,
              projectId: a.projectId,
              kind: "publications",
              data: {
                sourceId: src.id,
                status,
                receipt: "immutable-fixture-receipt",
              },
            },
          }),
        ),
      ),
    );
    await run(a, (tx) => revokeSource(tx, a, src.id));
    for (const original of publications) {
      const updated = await run(a, (tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: original.id } }),
      );
      expect(updated.data).toMatchObject({
        ...(original.data as object),
        dependencyInvalidated: true,
      });
      expect(
        await run(a, (tx) =>
          tx.entityVersion.count({ where: { entityId: original.id } }),
        ),
      ).toBe(1);
      const jobs = await run(a, (tx) =>
        tx.entity.count({
          where: {
            kind: "jobs",
            data: { path: ["resourceId"], equals: original.id },
          },
        }),
      );
      expect(jobs).toBe(
        (original.data as { status: string }).status === "published" ? 1 : 0,
      );
    }
  });
  it("fact withdrawal invalidates dependent workflow while retaining unrelated verified facts", async () => {
    const src = await source();
    const base = {
      value: "Fixture",
      valueType: "text" as const,
      language: "en",
      sourceId: src.id,
      validFrom: new Date(at.getTime() - 3600000).toISOString(),
      status: "verified" as const,
      publicUse: true,
      modelUse: true,
    };
    const f = await run(a, (tx) =>
      setFact(tx, a, { ...base, key: "withdrawn.feature" }),
    );
    await run(a, (tx) =>
      setFact(tx, a, { ...base, key: "independent.feature" }),
    );
    const e = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "withdrawn.feature",
        factKeys: ["withdrawn.feature"],
        purpose: "public",
        at,
      }),
    );
    const independent = await run(a, (tx) =>
      retrieve(tx, a, {
        query: "independent.feature",
        factKeys: ["independent.feature"],
        purpose: "public",
        at,
      }),
    );
    const dependencies = await run(a, async (tx) => {
      const content = await tx.entity.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          kind: "content",
          data: { evidenceId: e.id, status: "approved" },
        },
      });
      const approval = await tx.entity.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          kind: "approvals",
          data: { resourceId: content.id, status: "approved" },
        },
      });
      const publication = await tx.entity.create({
        data: {
          workspaceId: a.workspaceId,
          projectId: a.projectId,
          kind: "publications",
          data: { contentId: content.id, status: "queued" },
        },
      });
      return { content, approval, publication };
    });
    const result = await run(a, (tx) => withdrawFact(tx, a, f.id, f.version));
    expect(result.fact.data).toMatchObject({ status: "revoked" });
    for (const [item, status] of [
      [dependencies.content, "needs_review"],
      [dependencies.approval, "invalidated"],
      [dependencies.publication, "blocked_dependency"],
    ] as const)
      expect(
        (
          await run(a, (tx) =>
            tx.entity.findUniqueOrThrow({ where: { id: item.id } }),
          )
        ).data,
      ).toMatchObject({ status });
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, e.id, at))).valid,
    ).toBe(false);
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, independent.id, at))).valid,
    ).toBe(true);
    await expect(
      run(a, (tx) => withdrawFact(tx, a, f.id, f.version)),
    ).rejects.toThrow("VERSION_CONFLICT");
    expect(
      await run(a, (tx) =>
        tx.entityVersion.count({ where: { entityId: f.id } }),
      ),
    ).toBe(1);
  });
  it("source revocation purges vectors/evidence and fences jobs", async () => {
    const src = await source();
    const data = input(src.id, "REVOCABLE928 product reference");
    const doc = await run(a, (tx) => ingest(tx, a, data));
    const e = await run(a, (tx) =>
      retrieve(tx, a, { query: "REVOCABLE928", purpose: "public", at }),
    );
    await run(a, (tx) => revokeSource(tx, a, src.id));
    expect(
      (await run(a, (tx) => validateEvidence(tx, a, e.id, at))).valid,
    ).toBe(false);
    expect(
      await run(a, (tx) =>
        tx.knowledgeChunk.count({
          where: { documentVersionId: doc.versionId },
        }),
      ),
    ).toBe(0);
    const purged = await run(a, (tx) =>
      tx.entity.findUnique({ where: { id: e.id } }),
    );
    expect((purged?.data as unknown as EvidenceData).items).toEqual([]);
    await expect(run(a, (tx) => ingest(tx, a, data))).rejects.toThrow(
      "SOURCE_UNAVAILABLE",
    );
  });
  it("pause/resume cannot revive an old ingestion or embedding job", async () => {
    const src = await source();
    const data = input(src.id);
    await run(a, (tx) => setSourceRights(tx, a, src.id, { paused: true }));
    await run(a, (tx) => setSourceRights(tx, a, src.id, { paused: false }));
    await expect(run(a, (tx) => ingest(tx, a, data))).rejects.toThrow(
      "STALE_SOURCE_GENERATION",
    );
  });
  it("document tombstone prevents a repeated import after deletion", async () => {
    const src = await source();
    const data = input(src.id);
    const doc = await run(a, (tx) => ingest(tx, a, data));
    await run(a, (tx) => revokeDocument(tx, a, doc.documentId));
    await expect(
      run(a, (tx) => ingest(tx, a, { ...data, expectedGeneration: 2 })),
    ).rejects.toThrow("DOCUMENT_REVOKED");
  });
  it("external model permission is independent from public use", async () => {
    const src = await source(a, { modelUse: false });
    const doc = await run(a, (tx) => ingest(tx, a, input(src.id)));
    await expect(
      run(a, (tx) =>
        attachEmbeddings(tx, a, {
          sourceId: src.id,
          versionId: doc.versionId,
          expectedGeneration: 1,
          profile: EMBEDDING_PROFILE,
          vectors: [],
        }),
      ),
    ).rejects.toThrow("MODEL_USE_FORBIDDEN");
  });
});
