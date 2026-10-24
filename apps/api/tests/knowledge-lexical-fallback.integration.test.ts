import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { createPackageProject } from "./support/package-project.ts";
import { retrieveHybrid } from "../src/platform/knowledge/retrieval.ts";
import { data } from "../src/shared.ts";

// A project whose active index holds no embedding (FamilyPlan before its
// first index build) searches full-text without buying a query embedding:
// the search works on a Claude-only setup without an embedding price or
// key, and no reservation is made. Indexes with embeddings stay hybrid.

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

describe.skipIf(!enabled)("Knowledge search without embeddings", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const request = () => ({
    query: "Beta access for product teams",
    language: "en",
    purpose: "public" as const,
    forModel: true,
    at: new Date(),
    topK: 6,
  });
  const reservations = () =>
    run((tx) => tx.budgetReservation.count({ where: { projectId: project.owner.projectId } }));

  beforeAll(async () => {
    project = await createPackageProject({ name: "Synthetic lexical fallback" });
    await run(async (tx) => {
      await tx.chunkEmbedding.deleteMany({ where: { projectId: project.owner.projectId } });
      // No embedding price either, as on a Claude-only project.
      const config = await tx.entity.findFirstOrThrow({
        where: { projectId: project.owner.projectId, kind: "openai_configuration" },
      });
      const { "text-embedding-3-small": _drop, ...rateCard } = data(config).rateCard;
      await tx.entity.update({
        where: { id: config.id },
        data: { data: { ...data(config), rateCard } },
      });
    });
  });
  afterAll(async () => {
    await project?.cleanup();
    await closeDatabase();
  });

  it("finds passages full-text and reserves nothing", async () => {
    const before = await reservations();
    const jobKey = `lexical:${randomUUID()}`;
    const evidence = await retrieveHybrid(project.owner, request(), jobKey);
    expect(data(evidence)).toMatchObject({ status: "ready", mode: "lexical_degraded" });
    expect(await reservations()).toBe(before);
    // The job key is recorded: a retry returns the same evidence.
    const again = await retrieveHybrid(project.owner, request(), jobKey);
    expect(again.id).toBe(evidence.id);
  });
});
