import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
  type Prisma,
} from "../../../packages/db/src/index.ts";
import {
  retrieve,
  setSourceRights as rawSetSourceRights,
  validateEvidence,
} from "../../../packages/knowledge/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  ingest,
  restampSource,
  revokeSource,
  setSourceRights,
} from "../src/platform/knowledge/engine.ts";
import {
  fetchChunkForModel,
  searchForModel,
} from "../src/platform/knowledge/mcp-read.ts";
import {
  embedDocument,
  queueDocumentEmbedding,
} from "../src/platform/knowledge/ingestion.ts";
import { knowledgeSearch } from "../src/platform/knowledge/search.ts";
import { knowledgeIndexStatus } from "../src/platform/knowledge/index-status.ts";
import { registeredImpactHandlers } from "../src/platform/modules/contributions.ts";
import { create } from "../src/shared.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;

/**
 * Indexing and retrieval of stored knowledge documents
 * (plans/knowledge-indexing-repair.md): an imported document is searchable
 * at once (lexically, without paid embeddings), updates replace it without
 * duplicates, failures and blockers are visible, documents left behind by a
 * source change are re-attached (backfill) idempotently, and rights and
 * project isolation hold. Every check runs against the real database and
 * the real retrieval; nothing is mocked.
 */
describe.skipIf(!enabled)("Knowledge indexing and retrieval", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let scope: Scope;
  let other: Scope;
  const run = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, work);

  async function source(s: Scope, overrides: Record<string, unknown> = {}) {
    return run(
      s,
      async (tx) =>
        (
          await tx.entity.create({
            data: {
              workspaceId: s.workspaceId,
              projectId: s.projectId,
              kind: "sources",
              data: {
                name: "Synthetic curated knowledge",
                type: "manual",
                status: "active",
                generation: 1,
                publicUse: false,
                modelUse: true,
                authority: "official",
                maxAgeHours: 8760,
                allowedOrigins: [],
                allowedPaths: [],
                ...overrides,
              } as Prisma.InputJsonObject,
            },
          })
        ).id,
    );
  }
  const add = (
    s: Scope,
    sourceId: string,
    externalId: string,
    title: string,
    text: string,
  ) =>
    run(s, (tx) =>
      ingest(tx, s, {
        sourceId,
        externalId,
        title,
        text,
        mimeType: "text/markdown",
        language: "de",
      }),
    );
  const hits = async (s: Scope, query: string) =>
    (await searchForModel(s, query, { budget: null })).hits.flatMap((h) =>
      h.kind === "chunk" ? [h] : [],
    );
  const status = async (s: Scope, sourceId: string) =>
    (await run(s, (tx) => knowledgeIndexStatus(tx, s))).find(
      (x) => x.sourceId === sourceId,
    )!;

  beforeAll(async () => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic knowledge owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic knowledge indexing",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Indexing project",
        language: "de",
        contentLanguages: ["de"],
      },
    });
    const second = await authDb.project.create({
      data: {
        workspaceId: workspace.id,
        name: "Indexing other project",
        language: "de",
        contentLanguages: ["de"],
      },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    other = { ...scope, projectId: second.id };
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("makes an imported document searchable at once, with title, source and version", async () => {
    const sourceId = await source(scope);
    const imported = await add(
      scope,
      sourceId,
      "06_PREISE.md",
      "Preise und Abonnements",
      "# Preise\n\nDas Familienabo Quellwerkpreis kostet monatlich einen festen Betrag.",
    );
    expect(imported.embedded).toBe(0);
    const found = await hits(scope, "Quellwerkpreis");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sourceId,
      documentVersionId: imported.versionId,
      title: "Preise und Abonnements",
    });
    await expect(
      fetchChunkForModel(scope, found[0]!.chunkId),
    ).resolves.toMatchObject({
      sourceId,
      documentVersionId: imported.versionId,
    });
    expect(await status(scope, sourceId)).toMatchObject({
      state: "ready",
      searchMode: "lexical",
      documents: 1,
      chunks: imported.chunks,
      embeddedChunks: 0,
      blockers: [],
    });
  });

  it("answers a natural-language question with the specific passage, not the overview that repeats the product name", async () => {
    const sourceId = await source(scope);
    for (const [name, text] of [
      [
        "00_START.md",
        "Rangwortprodukt Rangwortprodukt Rangwortprodukt: Überblick über Rangwortprodukt, Familien und Rangwortprodukt im Alltag.",
      ],
      [
        "01_PRODUKT.md",
        "Rangwortprodukt organisiert Familien. Rangwortprodukt ist eine App.",
      ],
      [
        "02_MARKETING.md",
        "Rangwortprodukt spricht Eltern an. Rangwortprodukt wirbt ruhig.",
      ],
      [
        "03_ARCHITEKTUR.md",
        "Rangwortprodukt nutzt ein gemeinsames Backend für Rangwortprodukt.",
      ],
    ] as const)
      await add(scope, sourceId, name, name, text);
    const specific = await add(
      scope,
      sourceId,
      "05_DATENSCHUTZ.md",
      "Standorte",
      "Die Ortungsfreigabewort ist freiwillig, pro Profil widerrufbar, und Kinder behalten ihre Rechte.",
    );
    const found = await hits(
      scope,
      "Wie funktioniert die freiwillige Ortungsfreigabewort bei Rangwortprodukt und welche Rechte haben Kinder?",
    );
    expect(found[0]!.documentVersionId).toBe(specific.versionId);
  });

  it("replaces an updated document without duplicate chunks", async () => {
    const sourceId = await source(scope);
    const first = await add(
      scope,
      sourceId,
      "02_FUNKTIONEN.md",
      "Funktionen",
      "Schulkinder nutzen den Stundenplan Altwortfunk.",
    );
    const again = await add(
      scope,
      sourceId,
      "02_FUNKTIONEN.md",
      "Funktionen",
      "Schulkinder nutzen den Stundenplan Altwortfunk.",
    );
    expect(again).toMatchObject({
      unchanged: true,
      versionId: first.versionId,
    });
    const updated = await add(
      scope,
      sourceId,
      "02_FUNKTIONEN.md",
      "Funktionen",
      "Schulkinder nutzen den Stundenplan Neuwortfunk und Hausaufgaben.",
    );
    expect(updated.versionId).not.toBe(first.versionId);
    expect(await hits(scope, "Altwortfunk")).toEqual([]);
    const current = await hits(scope, "Neuwortfunk");
    expect(current).toHaveLength(1);
    expect(current[0]!.documentVersionId).toBe(updated.versionId);
    expect(await status(scope, sourceId)).toMatchObject({
      documents: 1,
      chunks: updated.chunks,
    });
  });

  it("reports a failed embedding job with its cause and does not queue duplicates", async () => {
    const sourceId = await source(scope);
    const doc = await add(
      scope,
      sourceId,
      "03_FEHLER.md",
      "Fehlerfall",
      "Der Einbettungsfehler Fehlwortzeta wird angezeigt.",
    );
    const queued = await run(scope, (tx) =>
      queueDocumentEmbedding(tx, scope, doc.documentId),
    );
    const again = await run(scope, (tx) =>
      queueDocumentEmbedding(tx, scope, doc.documentId),
    );
    expect((again as { id: string }).id).toBe((queued as { id: string }).id);
    expect(await status(scope, sourceId)).toMatchObject({
      state: "pending",
      jobs: { pending: 1, failed: 0 },
    });
    await run(scope, (tx) =>
      create(tx, scope, "jobs", {
        topic: "embedding",
        resourceId: doc.documentId,
        idempotencyKey: `embedding:test-failed:${randomUUID()}`,
        status: "failed",
        error: "EMBEDDING_COST_UNKNOWN",
      }),
    );
    const failed = await status(scope, sourceId);
    expect(failed).toMatchObject({
      state: "failed",
      jobs: { failed: 1, lastError: "EMBEDDING_COST_UNKNOWN" },
    });
    // A failed embedding never hides the lexical search.
    expect(await hits(scope, "Fehlwortzeta")).toHaveLength(1);
  });

  it("backfills documents left on an older source generation, idempotently and without duplicates", async () => {
    const sourceId = await source(scope);
    const doc = await add(
      scope,
      sourceId,
      "08_SUPPORT.md",
      "Support-FAQ",
      "Konto loeschen: Kontolöschwort in den Einstellungen.\n\nAbo verwalten im Store.",
    );
    const before = await run(scope, (tx) =>
      tx.documentVersion.findUniqueOrThrow({ where: { id: doc.versionId } }),
    );
    // A change from before this repair: the generation moved, the stored
    // versions did not, and the source vanished from every search.
    await run(scope, (tx) =>
      rawSetSourceRights(tx, scope, registeredImpactHandlers(), sourceId, {
        modelUse: true,
      }),
    );
    expect(await hits(scope, "Kontolöschwort")).toEqual([]);
    expect(await status(scope, sourceId)).toMatchObject({
      state: "pending",
      outdatedDocuments: 1,
      blockers: ["outdated_generation"],
      searchMode: "none",
    });
    const first = await run(scope, (tx) => restampSource(tx, scope, sourceId));
    expect(first).toMatchObject({ documents: 1, generation: 2 });
    const second = await run(scope, (tx) => restampSource(tx, scope, sourceId));
    expect(second).toMatchObject({ documents: 0, chunks: 0 });
    const found = await hits(scope, "Kontolöschwort");
    expect(found).toHaveLength(1);
    const after = await run(scope, (tx) =>
      tx.documentVersion.findUniqueOrThrow({
        where: { id: found[0]!.documentVersionId },
        include: { chunks: true },
      }),
    );
    // The same content and import time: freshness is not extended.
    expect(after).toMatchObject({
      sourceGeneration: 2,
      contentHash: before.contentHash,
      text: before.text,
    });
    expect(after.fetchedAt.toISOString()).toBe(before.fetchedAt.toISOString());
    expect(after.chunks).toHaveLength(doc.chunks);
    expect(await status(scope, sourceId)).toMatchObject({
      state: "ready",
      outdatedDocuments: 0,
      chunks: doc.chunks,
    });
  });

  it("makes a generated source searchable only after the owner reclassifies it", async () => {
    const sourceId = await source(scope, { authority: "generated" });
    await add(
      scope,
      sourceId,
      "04_ASSISTENT.md",
      "KI-Assistent",
      "Schreibende Aktionen bestätigt der Nutzer Bestätigungswortkappa.",
    );
    expect(await hits(scope, "Bestätigungswortkappa")).toEqual([]);
    expect((await status(scope, sourceId)).blockers).toContain(
      "generated_authority",
    );
    const changed = await run(scope, (tx) =>
      setSourceRights(tx, scope, sourceId, {
        authority: "official",
        maxAgeHours: 8760,
      }),
    );
    expect(changed).toMatchObject({
      generation: 2,
      reindexRequired: false,
      reindexed: { documents: 1 },
    });
    expect(await hits(scope, "Bestätigungswortkappa")).toHaveLength(1);
    const audit = await run(scope, (tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          resourceId: sourceId,
          action: { in: ["knowledge.rights_changed", "knowledge.restamped"] },
        },
      }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      "knowledge.restamped",
      "knowledge.rights_changed",
    ]);
  });

  it("drops paused and revoked sources from search; a resumed source is searchable again", async () => {
    const sourceId = await source(scope);
    await add(
      scope,
      sourceId,
      "05_DATENSCHUTZ.md",
      "Datenschutz",
      "Die freiwillige Standortfreigabe Standortwortomega ist jederzeit widerrufbar.",
    );
    expect(await hits(scope, "Standortwortomega")).toHaveLength(1);
    await run(scope, (tx) =>
      setSourceRights(tx, scope, sourceId, { paused: true }),
    );
    expect(await hits(scope, "Standortwortomega")).toEqual([]);
    expect((await status(scope, sourceId)).blockers).toContain("source_paused");
    await run(scope, (tx) =>
      setSourceRights(tx, scope, sourceId, { paused: false }),
    );
    expect(await hits(scope, "Standortwortomega")).toHaveLength(1);
    await run(scope, (tx) => revokeSource(tx, scope, sourceId));
    expect(await hits(scope, "Standortwortomega")).toEqual([]);
    expect(await status(scope, sourceId)).toBeUndefined();
  });

  it("keeps modelUse=false content away from models", async () => {
    const sourceId = await source(scope, { modelUse: false });
    const doc = await add(
      scope,
      sourceId,
      "09_INTERN.md",
      "Nur intern",
      "Das Geheimwort Modellsperrwort darf kein Modell lesen.",
    );
    expect(await hits(scope, "Modellsperrwort")).toEqual([]);
    expect((await status(scope, sourceId)).blockers).toContain(
      "model_use_forbidden",
    );
    // No embedding provider ever receives it: the job stops before any spend.
    await expect(
      embedDocument(scope, doc.documentId, randomUUID()),
    ).rejects.toMatchObject({ code: "MODEL_USE_FORBIDDEN" });
    expect(
      await run(scope, (tx) =>
        tx.budgetReservation.count({ where: { projectId: scope.projectId } }),
      ),
    ).toBe(0);
    // The owner's own inspection (forModel false) still sees it.
    const evidence = await run(scope, (tx) =>
      retrieve(tx, scope, {
        query: "Modellsperrwort",
        purpose: "internal",
        forModel: false,
        language: "de",
      }),
    );
    expect((evidence.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it("never turns publicUse=false knowledge into public evidence", async () => {
    const sourceId = await source(scope);
    await add(
      scope,
      sourceId,
      "07_MARKETING.md",
      "Marketing intern",
      "Die interne Kampagnenidee Kampagnenwortsigma ist nicht öffentlich.",
    );
    // Marketing and support search publicly: nothing.
    const publicSearch = await knowledgeSearch(scope, {
      query: "Kampagnenwortsigma",
    });
    expect((publicSearch.result as { passages: unknown[] }).passages).toEqual(
      [],
    );
    // The model read finds it, as internal evidence that is never public-ready.
    const internalSearch = await knowledgeSearch(
      scope,
      { query: "Kampagnenwortsigma" },
      undefined,
      undefined,
      undefined,
      { shared: false, purpose: "internal" },
    );
    const result = internalSearch.result as {
      passages: unknown[];
      retrieval: { evidenceId: string };
    };
    expect(result.passages).toHaveLength(1);
    const validation = await run(scope, (tx) =>
      validateEvidence(tx, scope, result.retrieval.evidenceId),
    );
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("evidence_not_public_ready");
  });

  it("never returns another project's knowledge", async () => {
    const sourceId = await source(scope);
    await add(
      scope,
      sourceId,
      "10_ISOLATION.md",
      "Isolation",
      "Das Projektwort Isolationswortrho gehört nur diesem Projekt.",
    );
    const own = await hits(scope, "Isolationswortrho");
    expect(own).toHaveLength(1);
    expect(await hits(other, "Isolationswortrho")).toEqual([]);
    await expect(
      fetchChunkForModel(other, own[0]!.chunkId),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(
      (await run(other, (tx) => knowledgeIndexStatus(tx, other))).map(
        (x) => x.sourceId,
      ),
    ).not.toContain(sourceId);
  });
});
