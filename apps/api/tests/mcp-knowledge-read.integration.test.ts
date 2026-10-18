import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The paid hybrid path is replaceable per test: by default it runs for real
// (no spend mandate exists, so it stops at POLICY_REQUIRED before any
// spend); a test can make it fail with a chosen code. No network call is made.
const hybrid = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../src/platform/knowledge/retrieval.ts", async (original) => {
  const actual =
    await original<typeof import("../src/platform/knowledge/retrieval.ts")>();
  return {
    ...actual,
    retrieveHybrid: vi.fn(
      async (...args: Parameters<typeof actual.retrieveHybrid>) => {
        if (hybrid.error) throw hybrid.error;
        return actual.retrieveHybrid(...args);
      },
    ),
  };
});

import { randomUUID } from "node:crypto";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { Prisma } from "../../../packages/db/src/index.ts";
import { KnowledgeError } from "../../../packages/knowledge/src/index.ts";
import { ingest, setFact } from "../src/platform/knowledge/engine.ts";
import {
  fetchChunkForModel,
  fetchFactForModel,
  FETCH_TEXT_MAX_BYTES,
  searchForModel,
} from "../src/platform/knowledge/mcp-read.ts";
import { retrieveHybrid } from "../src/platform/knowledge/retrieval.ts";
import { DomainError } from "../src/platform/shared.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const HOUR = 3600000;
// The eligible chunk fixtures carry this word; every ineligible case carries
// a term of its own (see `chunkTerm`) next to an eligible control with the
// same term, so a search per case is not crowded out by the result caps
// (topK 6 passages, 8 facts) and cannot pass vacuously.
const TOKEN = "zephyrinemcp";
const FACT_PREFIX = "mcpreadfix";
const chunkTerm = (name: string) =>
  `zq${name.toLowerCase().replace(/[^a-z]/g, "")}`;
// Fact keys are `${FACT_PREFIX}.${term}`; a search for the bare term reaches
// the key segment (retrieval matches key segments of three or more letters).
const FACT_TERMS: Record<string, string> = {
  unverified: "unverified",
  conflicting: "conflicting",
  "conflicting peer": "conflicting",
  "disagreeing copy": "copies",
  "disagreeing copy peer": "copies",
  "fact modelUse false": "nomodel",
  "fact publicUse false": "nopublic",
  "expired fact": "expired",
  "not yet valid fact": "notyetvalid",
  "fact on restricted audience source": "audience",
  "fact on modelUse false source": "sourcenomodel",
  "fact on embargoed source": "sourceembargo",
  "fact on inactive source": "sourcepaused",
  "fact on generated source": "sourcegenerated",
  "fact of stale generation": "stalegeneration",
  "fact in other language": "german",
  "fact of other project": "otherproject",
};

/**
 * The knowledge read services behind the MCP `search` and `fetch` tools
 * (Track M WP-M3, Task 2): only what `retrieve(forModel: true, purpose:
 * "public")` without a consumer could return is visible, through search and
 * through a fetch by a guessed id alike (Review Focus "ineligible content is
 * invisible to search and fetch").
 */
describe.skipIf(!enabled)("MCP knowledge read services", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  let scope: Scope;
  let other: Scope;
  const chunks = new Map<string, { chunkId: string; versionId: string }>();
  const facts = new Map<string, string>();
  // One eligible control per ineligibility case, carrying the same term.
  const chunkControls = new Map<string, string>();
  const factControls = new Map<string, string>();
  const run = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, work);
  const past = () => new Date(Date.now() - HOUR).toISOString();

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
                name: "Synthetic MCP read source",
                type: "file",
                status: "active",
                generation: 1,
                publicUse: true,
                modelUse: true,
                authority: "official",
                maxAgeHours: 168,
                allowedOrigins: [],
                allowedPaths: [],
                ...overrides,
              },
            },
          })
        ).id,
    );
  }
  /** Changes a source record directly, as a later state change would. */
  async function patchSource(
    s: Scope,
    id: string,
    changes: Record<string, unknown>,
  ) {
    await run(s, async (tx) => {
      const row = await tx.entity.findFirstOrThrow({ where: { id } });
      await tx.entity.update({
        where: { id },
        data: {
          data: {
            ...(row.data as object),
            ...changes,
          } as Prisma.InputJsonObject,
        },
      });
    });
  }
  async function document(
    s: Scope,
    sourceId: string,
    overrides: Record<string, unknown> = {},
    externalId: string = randomUUID(),
    term: string = TOKEN,
  ) {
    const result = await run(s, (tx) =>
      ingest(tx, s, {
        sourceId,
        externalId,
        title: "MCP read fixture",
        // Distinct texts: identical chunks would be deduplicated by hash.
        text: `Orbit ${term} reference passage ${randomUUID()}.`,
        mimeType: "text/plain",
        language: "en",
        validFrom: new Date(Date.now() - 2 * HOUR).toISOString(),
        ...overrides,
      }),
    );
    const chunk = await run(s, (tx) =>
      tx.knowledgeChunk.findFirstOrThrow({
        where: { documentVersionId: result.versionId },
        orderBy: { position: "asc" },
      }),
    );
    return { chunkId: chunk.id, versionId: result.versionId };
  }
  async function fact(
    s: Scope,
    sourceId: string,
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    return run(
      s,
      async (tx) =>
        (
          await setFact(tx, s, {
            key: `${FACT_PREFIX}.${name}`,
            value: `value of ${name}`,
            valueType: "text",
            language: "en",
            sourceId,
            validFrom: past(),
            status: "verified",
            publicUse: true,
            modelUse: true,
            ...overrides,
          } as Parameters<typeof setFact>[2])
        ).id,
    );
  }
  async function reservations(s: Scope) {
    return run(s, (tx) =>
      tx.budgetReservation.count({ where: { projectId: s.projectId } }),
    );
  }
  const lexical = () => searchForModel(scope, TOKEN, { budget: null });
  const chunkHits = async (term: string) =>
    new Set(
      (await searchForModel(scope, term, { budget: null })).hits.flatMap((h) =>
        h.kind === "chunk" ? [h.chunkId] : [],
      ),
    );
  const factHits = async (term: string) =>
    new Set(
      (await searchForModel(scope, term, { budget: null })).hits.flatMap((h) =>
        h.kind === "fact" ? [h.factId] : [],
      ),
    );

  beforeAll(async () => {
    const userId = randomUUID();
    await authDb.user.create({
      data: {
        id: userId,
        name: "Synthetic MCP read owner",
        email: `${randomUUID()}@example.invalid`,
      },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic MCP read",
        members: { create: { userId, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "MCP read project" },
    });
    const second = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "MCP read other project" },
    });
    scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    other = { ...scope, projectId: second.id };

    // Eligible chunks.
    chunks.set(
      "eligible",
      await document(scope, await source(scope), {
        canonicalUrl: "https://docs.example.com/guide?utm_source=x#part",
      }),
    );
    chunks.set(
      "eligible audience all",
      await document(scope, await source(scope, { audiences: ["all"] })),
    );
    // Ineligible chunks, one rule each, each with a term of its own.
    const bad = (
      name: string,
      sourceId: Promise<string>,
      overrides: Record<string, unknown> = {},
    ) =>
      sourceId.then((id) =>
        document(scope, id, overrides, undefined, chunkTerm(name)),
      );
    chunks.set(
      "modelUse false",
      await bad("modelUse false", source(scope, { modelUse: false })),
    );
    chunks.set(
      "publicUse false",
      await bad("publicUse false", source(scope, { publicUse: false })),
    );
    chunks.set(
      "embargoed",
      await bad(
        "embargoed",
        source(scope, {
          embargoUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
        }),
      ),
    );
    chunks.set(
      "generated authority",
      await bad(
        "generated authority",
        source(scope, { authority: "generated" }),
      ),
    );
    const paused = await source(scope);
    chunks.set(
      "inactive source",
      await document(
        scope,
        paused,
        {},
        undefined,
        chunkTerm("inactive source"),
      ),
    );
    await patchSource(scope, paused, { status: "paused" });
    const superseded = await source(scope);
    const externalId = randomUUID();
    chunks.set(
      "superseded version",
      await document(
        scope,
        superseded,
        {},
        externalId,
        chunkTerm("superseded version"),
      ),
    );
    // The successor is the eligible control of the superseded version and an
    // eligible variant in its own right.
    chunks.set(
      "eligible successor version",
      await document(
        scope,
        superseded,
        {},
        externalId,
        `${TOKEN} ${chunkTerm("superseded version")}`,
      ),
    );
    const regenerated = await source(scope);
    chunks.set(
      "stale generation",
      await document(
        scope,
        regenerated,
        {},
        undefined,
        chunkTerm("stale generation"),
      ),
    );
    await patchSource(scope, regenerated, { generation: 2 });
    chunks.set(
      "expired validity",
      await bad("expired validity", source(scope), {
        validFrom: new Date(Date.now() - 3 * HOUR).toISOString(),
        validUntil: new Date(Date.now() - HOUR).toISOString(),
      }),
    );
    chunks.set(
      "not yet valid",
      await bad("not yet valid", source(scope), {
        validFrom: new Date(Date.now() + HOUR).toISOString(),
      }),
    );
    const stale = await document(
      scope,
      await source(scope),
      {},
      undefined,
      chunkTerm("stale fetch"),
    );
    await run(scope, (tx) =>
      tx.documentVersion.update({
        where: { id: stale.versionId },
        data: { fetchedAt: new Date(Date.now() - 30 * 24 * HOUR) },
      }),
    );
    chunks.set("stale fetch", stale);
    chunks.set(
      "restricted audience",
      await bad(
        "restricted audience",
        source(scope, { audiences: ["marketing"] }),
      ),
    );
    chunks.set(
      "malformed audience",
      await bad("malformed audience", source(scope, { audiences: "support" })),
    );
    chunks.set(
      "other language",
      await bad("other language", source(scope), { language: "de" }),
    );
    chunks.set(
      "other project",
      await document(
        other,
        await source(other),
        {},
        undefined,
        chunkTerm("other project"),
      ),
    );
    // An eligible control per term; the superseded version has its successor.
    for (const name of [
      "modelUse false",
      "publicUse false",
      "embargoed",
      "generated authority",
      "inactive source",
      "stale generation",
      "expired validity",
      "not yet valid",
      "stale fetch",
      "restricted audience",
      "malformed audience",
      "other language",
      "other project",
    ])
      chunkControls.set(
        name,
        (
          await document(
            scope,
            await source(scope),
            {},
            undefined,
            chunkTerm(name),
          )
        ).chunkId,
      );
    chunkControls.set(
      "superseded version",
      chunks.get("eligible successor version")!.chunkId,
    );

    // Facts, each on its own source so source changes stay isolated.
    facts.set("eligible", await fact(scope, await source(scope), "eligible"));
    facts.set(
      "unverified",
      await fact(scope, await source(scope), "unverified", {
        status: "candidate",
      }),
    );
    const conflictSource = await source(scope);
    facts.set(
      "conflicting",
      await fact(scope, conflictSource, "conflicting", { value: "one" }),
    );
    facts.set(
      "conflicting peer",
      await fact(scope, conflictSource, "conflicting", { value: "two" }),
    );
    // Two verified copies that disagree without being marked conflicting
    // (written directly): K-1 refuses the key (FACT_CONFLICT).
    const copySource = await source(scope);
    for (const [name, value] of [
      ["disagreeing copy", "first"],
      ["disagreeing copy peer", "second"],
    ] as const)
      facts.set(
        name,
        await run(
          scope,
          async (tx) =>
            (
              await tx.entity.create({
                data: {
                  workspaceId: scope.workspaceId,
                  projectId: scope.projectId,
                  kind: "facts",
                  data: {
                    key: `${FACT_PREFIX}.copies`,
                    value,
                    valueType: "text",
                    language: "en",
                    sourceId: copySource,
                    sourceGeneration: 1,
                    validFrom: past(),
                    status: "verified",
                    publicUse: true,
                    modelUse: true,
                  },
                },
              })
            ).id,
        ),
      );
    facts.set(
      "fact modelUse false",
      await fact(scope, await source(scope), "nomodel", { modelUse: false }),
    );
    facts.set(
      "fact publicUse false",
      await fact(scope, await source(scope), "nopublic", { publicUse: false }),
    );
    facts.set(
      "expired fact",
      await fact(scope, await source(scope), "expired", {
        validFrom: new Date(Date.now() - 3 * HOUR).toISOString(),
        validUntil: new Date(Date.now() - HOUR).toISOString(),
      }),
    );
    facts.set(
      "not yet valid fact",
      await fact(scope, await source(scope), "notyetvalid", {
        validFrom: new Date(Date.now() + HOUR).toISOString(),
      }),
    );
    facts.set(
      "fact on restricted audience source",
      await fact(
        scope,
        await source(scope, { audiences: ["marketing"] }),
        "audience",
      ),
    );
    const withdrawn = await source(scope);
    facts.set(
      "fact on modelUse false source",
      await fact(scope, withdrawn, "sourcenomodel"),
    );
    await patchSource(scope, withdrawn, { modelUse: false });
    const embargo = await source(scope);
    facts.set(
      "fact on embargoed source",
      await fact(scope, embargo, "sourceembargo"),
    );
    await patchSource(scope, embargo, {
      embargoUntil: new Date(Date.now() + 24 * HOUR).toISOString(),
    });
    // A fact cannot be set on a generated source (K-1); a source that turns
    // generated later leaves it behind.
    const generatedFactSource = await source(scope);
    facts.set(
      "fact on generated source",
      await fact(scope, generatedFactSource, "sourcegenerated"),
    );
    await patchSource(scope, generatedFactSource, { authority: "generated" });
    const pausedFactSource = await source(scope);
    facts.set(
      "fact on inactive source",
      await fact(scope, pausedFactSource, "sourcepaused"),
    );
    await patchSource(scope, pausedFactSource, { status: "paused" });
    const bumped = await source(scope);
    facts.set(
      "fact of stale generation",
      await fact(scope, bumped, "stalegeneration"),
    );
    await patchSource(scope, bumped, { generation: 2 });
    facts.set(
      "fact in other language",
      await fact(scope, await source(scope), "german", { language: "de" }),
    );
    facts.set(
      "fact of other project",
      await fact(other, await source(other), "otherproject"),
    );
    // An eligible control per term: `${term}.control` shares the key segment.
    for (const term of new Set(Object.values(FACT_TERMS)))
      factControls.set(
        term,
        await fact(scope, await source(scope), `${term}.control`),
      );
  }, 120000);

  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("finds and fetches an eligible chunk with its version and citation", async () => {
    const eligible = chunks.get("eligible")!;
    const result = await lexical();
    expect(result.mode).toBe("lexical_degraded");
    const hit = result.hits.find(
      (h) => h.kind === "chunk" && h.chunkId === eligible.chunkId,
    );
    expect(hit).toEqual({
      kind: "chunk",
      chunkId: eligible.chunkId,
      documentVersionId: eligible.versionId,
      sourceId: expect.any(String),
      title: "MCP read fixture",
      canonicalUrl: "https://docs.example.com/guide",
    });
    const fetched = await fetchChunkForModel(scope, eligible.chunkId);
    const version = await run(scope, (tx) =>
      tx.documentVersion.findUniqueOrThrow({
        where: { id: eligible.versionId },
      }),
    );
    expect(fetched).toEqual({
      title: "MCP read fixture",
      text: version.text,
      truncated: false,
      documentVersionId: eligible.versionId,
      sourceId: hit!.sourceId,
      canonicalUrl: "https://docs.example.com/guide",
      fetchedAt: version.fetchedAt.toISOString(),
    });
  });

  it("eligible variants are visible to search and fetch", async () => {
    const hits = await chunkHits(TOKEN);
    for (const name of [
      "eligible",
      "eligible audience all",
      "eligible successor version",
    ]) {
      const { chunkId, versionId } = chunks.get(name)!;
      expect(hits, name).toContain(chunkId);
      await expect(
        fetchChunkForModel(scope, chunkId),
        name,
      ).resolves.toMatchObject({ documentVersionId: versionId });
    }
  });

  describe("ineligible content is invisible to search and fetch", () => {
    const ineligibleChunks = [
      "modelUse false",
      "publicUse false",
      "embargoed",
      "generated authority",
      "inactive source",
      "superseded version",
      "stale generation",
      "expired validity",
      "not yet valid",
      "stale fetch",
      "restricted audience",
      "malformed audience",
      "other language",
      "other project",
    ];
    it.each(ineligibleChunks)("chunk: %s", async (name) => {
      const { chunkId } = chunks.get(name)!;
      // Searched by its own term: the eligible control with the same term
      // must come back (the search is not vacuous), the ineligible chunk not.
      const hits = await chunkHits(chunkTerm(name));
      expect(hits).toContain(chunkControls.get(name)!);
      expect(hits).not.toContain(chunkId);
      await expect(fetchChunkForModel(scope, chunkId)).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    });

    const ineligibleFacts = Object.keys(FACT_TERMS);
    it.each(ineligibleFacts)("fact: %s", async (name) => {
      const factId = facts.get(name)!;
      const term = FACT_TERMS[name]!;
      const hits = await factHits(term);
      expect(hits).toContain(factControls.get(term)!);
      expect(hits).not.toContain(factId);
      await expect(fetchFactForModel(scope, factId)).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
      });
    });

    it("unknown and malformed ids answer the same NOT_FOUND", async () => {
      for (const id of [randomUUID(), "not-a-uuid", "", "'; DROP TABLE x"]) {
        await expect(fetchChunkForModel(scope, id)).rejects.toMatchObject({
          code: "NOT_FOUND",
          status: 404,
        });
        await expect(fetchFactForModel(scope, id)).rejects.toMatchObject({
          code: "NOT_FOUND",
          status: 404,
        });
      }
    });
  });

  it("finds and fetches an eligible fact", async () => {
    const factId = facts.get("eligible")!;
    const result = await searchForModel(scope, "eligible", { budget: null });
    const hit = result.hits.find(
      (h) => h.kind === "fact" && h.factId === factId,
    );
    expect(hit).toEqual({
      kind: "fact",
      factId,
      sourceId: expect.any(String),
      key: `${FACT_PREFIX}.eligible`,
      canonicalUrl: null,
    });
    await expect(fetchFactForModel(scope, factId)).resolves.toEqual({
      key: `${FACT_PREFIX}.eligible`,
      value: "value of eligible",
      sourceId: hit!.sourceId,
      canonicalUrl: null,
    });
  });

  it("returns a fact's unit and currency", async () => {
    const factId = await fact(scope, await source(scope), "price", {
      value: "49.90",
      valueType: "decimal",
      currency: "EUR",
      unit: "month",
    });
    await expect(fetchFactForModel(scope, factId)).resolves.toMatchObject({
      key: `${FACT_PREFIX}.price`,
      value: "49.90",
      currency: "EUR",
      unit: "month",
    });
  });

  it("truncates a long version text at 48 KB on a character boundary", async () => {
    // One byte of offset, then 4-byte characters: the 48 KB limit falls
    // inside a character.
    const text =
      "a" +
      Array.from(
        { length: 300 },
        (_, i) => `Paragraph ${i} truncation ${"é🚀".repeat(40)}`,
      ).join("\n\n");
    expect(Buffer.byteLength(text)).toBeGreaterThan(FETCH_TEXT_MAX_BYTES);
    const long = await document(scope, await source(scope), { text });
    const version = await run(scope, (tx) =>
      tx.documentVersion.findUniqueOrThrow({ where: { id: long.versionId } }),
    );
    const fetched = await fetchChunkForModel(scope, long.chunkId);
    expect(FETCH_TEXT_MAX_BYTES).toBe(48 * 1024);
    expect(fetched.truncated).toBe(true);
    const bytes = Buffer.byteLength(fetched.text);
    expect(bytes).toBeLessThanOrEqual(FETCH_TEXT_MAX_BYTES);
    expect(bytes).toBeGreaterThan(FETCH_TEXT_MAX_BYTES - 4);
    expect(version.text.startsWith(fetched.text)).toBe(true);
    // No broken character at the end.
    expect(Buffer.from(fetched.text, "utf8").toString("utf8")).toBe(
      fetched.text,
    );
    expect(fetched.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  describe("search modes", () => {
    it("searches lexically without a budget and spends nothing", async () => {
      vi.mocked(retrieveHybrid).mockClear();
      const result = await lexical();
      expect(result.mode).toBe("lexical_degraded");
      expect(retrieveHybrid).not.toHaveBeenCalled();
      expect(await reservations(scope)).toBe(0);
    });

    it("falls back to lexical when the project has no spend mandate", async () => {
      vi.mocked(retrieveHybrid).mockClear();
      const result = await searchForModel(scope, TOKEN, {
        budget: {
          retrievalJobKey: `test:${randomUUID()}`,
          budgetRunKey: `test:${randomUUID()}`,
        },
      });
      expect(retrieveHybrid).toHaveBeenCalledTimes(1);
      expect(result.mode).toBe("lexical_degraded");
      expect(
        result.hits.some(
          (h) =>
            h.kind === "chunk" && h.chunkId === chunks.get("eligible")!.chunkId,
        ),
      ).toBe(true);
      expect(await reservations(scope)).toBe(0);
    });

    it.each([
      new DomainError("POLICY_REQUIRED"),
      new DomainError("PAID_MANDATE_EXPIRED"),
      new DomainError("BUDGET_NOT_APPROVED"),
      new DomainError("BUDGET_EXCEEDED", 409),
      new DomainError("RUN_BUDGET_EXCEEDED", 409),
      new DomainError("PROJECT_PAUSED"),
      new KnowledgeError("NO_ACTIVE_EMBEDDING_INDEX"),
      new DomainError("OPENAI_API_KEY_REQUIRED"),
      // The cost estimate's price checks (plain errors), before reserve.
      new Error("VERIFIED_PRICE_CONFIGURATION_REQUIRED"),
      new Error("CURRENT_PRICE_REQUIRED"),
    ])("falls back to lexical before any spend: $message", async (error) => {
      hybrid.error = error;
      try {
        vi.mocked(retrieveHybrid).mockClear();
        const trace = { agentRunId: randomUUID(), taskClass: "mcp_search" };
        const result = await searchForModel(scope, TOKEN, {
          budget: {
            retrievalJobKey: `test:${randomUUID()}`,
            budgetRunKey: `test:${randomUUID()}`,
          },
          trace,
        });
        expect(result.mode).toBe("lexical_degraded");
        expect(result.hits.length).toBeGreaterThan(0);
        // The paid attempt carried the run and no consumer (D-M3-4).
        const [, request, , , passedTrace] =
          vi.mocked(retrieveHybrid).mock.calls[0]!;
        expect(request).toMatchObject({ forModel: true, purpose: "public" });
        expect("consumer" in request).toBe(false);
        expect(passedTrace).toEqual(trace);
      } finally {
        hybrid.error = null;
      }
    });

    it.each([
      new DomainError("QUERY_EMBEDDING_COST_UNKNOWN"),
      new DomainError("QUERY_POLICY_CHANGED"),
      new DomainError("RESERVATION_ALREADY_USED", 409),
      new Error("unexpected"),
    ])(
      "does not fall back after a failure that may have spent: $message",
      async (error) => {
        hybrid.error = error;
        try {
          await expect(
            searchForModel(scope, TOKEN, {
              budget: {
                retrievalJobKey: `test:${randomUUID()}`,
                budgetRunKey: `test:${randomUUID()}`,
              },
            }),
          ).rejects.toBe(error);
        } finally {
          hybrid.error = null;
        }
      },
    );

    it("does not fall back once the call's reservation exists", async () => {
      const retrievalJobKey = `test:${randomUUID()}`;
      await run(scope, (tx) =>
        tx.budgetReservation.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            key: `${scope.projectId}:query:${retrievalJobKey}`,
            category: "query_embedding",
            amountMicros: 1n,
            state: "reserved",
          },
        }),
      );
      const error = new DomainError("BUDGET_EXCEEDED", 409);
      hybrid.error = error;
      try {
        await expect(
          searchForModel(scope, TOKEN, {
            budget: { retrievalJobKey, budgetRunKey: `test:${randomUUID()}` },
          }),
        ).rejects.toBe(error);
      } finally {
        hybrid.error = null;
      }
    });

    it("a query that matches nothing is an empty list", async () => {
      await expect(
        searchForModel(scope, `nomatch${randomUUID().slice(0, 8)}`, {
          budget: null,
        }),
      ).resolves.toEqual({ mode: "lexical_degraded", hits: [] });
    });
  });
});
