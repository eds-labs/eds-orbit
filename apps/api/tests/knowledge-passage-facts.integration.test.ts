import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { retrieve } from "../../../packages/knowledge/src/index.ts";
import { ingest, setFact } from "../src/platform/knowledge/engine.ts";
import { createPackageProject } from "./support/package-project.ts";
import { create, data } from "../src/shared.ts";

// A reviewed knowledge proposal becomes a verified-facts source with one
// passage (its quote) and one fact under a generated key. A search that
// finds the passage returns the fact too: no question names such a key, so
// before, the assistant saw the quote but no verified fact (FamilyPlan,
// 2026-10-24, FACTS_REQUIRED for a draft).

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

describe.skipIf(!enabled)("Facts of a found proposal passage", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let factKey = "";
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const search = (query: string, factKeys?: string[]) =>
    run(async (tx) =>
      data(
        await retrieve(tx, project.owner, {
          query,
          language: "de",
          purpose: "public",
          forModel: true,
          at: new Date(),
          topK: 6,
          ...(factKeys ? { factKeys } : {}),
        }),
      ),
    );

  beforeAll(async () => {
    project = await createPackageProject({ name: "Synthetic passage facts" });
    const s = project.owner;
    factKey = `knowledge.features.${randomUUID()}`;
    await run(async (tx) => {
      const source = await create(tx, s, "sources", {
        name: "Synthetic website",
        type: "verified_facts",
        status: "active",
        generation: 1,
        authority: "official",
        publicUse: true,
        modelUse: true,
        maxAgeHours: 8760,
        allowedOrigins: [],
        allowedPaths: ["/"],
        lastSuccessfulSyncAt: new Date().toISOString(),
      });
      await ingest(tx, s, {
        sourceId: source.id,
        externalId: randomUUID(),
        title: "Belohnungssystem",
        text: "Das Belohnungssystem macht erledigte Aufgaben sichtbar und motiviert Kinder ohne Druck.",
        mimeType: "text/plain",
        language: "de",
      });
      await setFact(tx, s, {
        sourceId: source.id,
        key: factKey,
        value: "FamilyPlan enthält ein Belohnungssystem für Kinder, das erledigte Aufgaben sichtbar macht.",
        valueType: "text",
        language: "de",
        validFrom: new Date(Date.now() - 60000).toISOString(),
        status: "verified",
        publicUse: true,
        modelUse: true,
      });
    });
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  it("returns the fact of a verified-facts source whose passage the search finds", async () => {
    const evidence = await search("Aufgaben und Belohnungssystem für Kinder");
    expect(evidence.status).toBe("ready");
    expect(evidence.items.length).toBeGreaterThan(0);
    expect(evidence.facts.map((f: { key: string }) => f.key)).toContain(factKey);
  });

  it("keeps an explicit fact request exact", async () => {
    const evidence = await search("Aufgaben und Belohnungssystem für Kinder", ["official.link"]);
    expect(evidence.facts.map((f: { key: string }) => f.key)).not.toContain(factKey);
  });
});
