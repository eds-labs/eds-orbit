import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  authDb,
  scoped,
  closeDatabase,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, data, list, update } from "../shared.ts";
import { retrieve, setFact } from "../../../../packages/knowledge/src/index.ts";
import {
  adaptContent,
  importCommunityQuestions,
  linkCommunityGroup,
  proposeBrief,
} from "./editorial.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Editorial workflows with isolated PostgreSQL state",
  () => {
    let scope: Scope, workspaceId: string, userId: string;
    const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
      scoped(scope.workspaceId, scope.projectId, fn);
    beforeAll(async () => {
      userId = randomUUID();
      await authDb.user.create({
        data: {
          id: userId,
          email: userId + "@example.invalid",
          name: "Synthetic editorial owner",
        },
      });
      workspaceId = (
        await authDb.workspace.create({
          data: {
            name: "Synthetic editorial suite",
            members: { create: { userId, role: "owner" } },
          },
        })
      ).id;
    });
    beforeEach(async () => {
      const project = await authDb.project.create({
        data: { workspaceId, name: "Synthetic editorial project" },
      });
      scope = { workspaceId, projectId: project.id, userId, role: "owner" };
    });
    afterAll(async () => {
      if (workspaceId)
        await authDb.workspace.delete({ where: { id: workspaceId } });
      if (userId) await authDb.user.delete({ where: { id: userId } });
      await closeDatabase();
    });
    const input = () => ({
      label: "Authorized support export",
      authorizationConfirmed: true as const,
      questions: [
        {
          externalId: "q1",
          text: "How can I export documents?",
          language: "en" as const,
        },
        {
          externalId: "q2",
          text: "Can I export documents please?",
          language: "en" as const,
        },
        {
          externalId: "q3",
          text: "I have a complaint about a refund",
          language: "en" as const,
        },
      ],
    });
    it("groups authorized untrusted imports, isolates complaints, preserves provenance and deduplicates reimports", async () => {
      const result = await run((tx) =>
        importCommunityQuestions(tx, scope, input()),
      );
      expect(result.imported).toBe(3);
      expect(result.groups).toHaveLength(2);
      expect(result.groups.map((g) => data(g).questionCount).sort()).toEqual([
        1, 2,
      ]);
      expect(
        result.groups.find((g) => data(g).reviewRequired)?.data,
      ).toMatchObject({ status: "review_required", publicReplyAllowed: false });
      expect(
        (await run((tx) => list(tx, scope, "community_questions")))[0]?.data,
      ).toMatchObject({
        untrusted: true,
        publicUse: false,
        modelUse: false,
        origin: "authorized_manual_import",
      });
      expect(
        await run((tx) => importCommunityQuestions(tx, scope, input())),
      ).toMatchObject({ imported: 0, skipped: 3 });
    });
    it("rejects absent authorization, viewer writes and changed stable import IDs", async () => {
      expect(() =>
        proposeBrief({ brief: "short", language: "en" }),
      ).not.toThrow();
      await expect(
        run((tx) =>
          importCommunityQuestions(tx, { ...scope, role: "viewer" }, input()),
        ),
      ).rejects.toThrow("EDITOR_REQUIRED");
      await expect(
        run((tx) =>
          importCommunityQuestions(tx, scope, {
            ...input(),
            authorizationConfirmed: false,
          } as any),
        ),
      ).rejects.toThrow();
      await run((tx) => importCommunityQuestions(tx, scope, input()));
      const changed = input();
      changed.questions[0]!.text = "Changed question for the same identity";
      await expect(
        run((tx) => importCommunityQuestions(tx, scope, changed)),
      ).rejects.toThrow("COMMUNITY_IMPORT_VERSION_CONFLICT");
    });
    it("links drafts/missions only in the current project and protects group versions", async () => {
      const imported = await run((tx) =>
        importCommunityQuestions(tx, scope, input()),
      );
      const group = imported.groups[0]!;
      const mission = await run((tx) =>
        create(tx, scope, "missions", { title: "Synthetic answer planning" }),
      );
      const result = await run((tx) =>
        linkCommunityGroup(tx, scope, {
          groupId: group.id,
          version: group.version,
          missionId: mission.id,
        }),
      );
      expect(data(result).missionIds).toEqual([mission.id]);
      await expect(
        run((tx) =>
          linkCommunityGroup(tx, scope, {
            groupId: group.id,
            version: group.version,
            missionId: mission.id,
          }),
        ),
      ).rejects.toThrow("VERSION_CONFLICT");
      const other = await authDb.project.create({
        data: { workspaceId, name: "Other editorial project" },
      });
      const foreign = await scoped(workspaceId, other.id, (tx) =>
        create(tx, { ...scope, projectId: other.id }, "content", {
          title: "Private draft",
        }),
      );
      await expect(
        run((tx) =>
          linkCommunityGroup(tx, scope, {
            groupId: result.id,
            version: result.version,
            contentId: foreign.id,
          }),
        ),
      ).rejects.toThrow("NOT_FOUND");
    });
    it("proposes only editable local text and leaves numbers, dates and permissions unknown", () => {
      const result = proposeBrief({
        brief: "Reach 100 people next Monday. Use a new channel.",
        language: "en",
      });
      expect(result.method).toBe("local_brief_template");
      expect(result.proposal).toEqual({
        title: "Reach 100 people next Monday",
        goal: "Reach 100 people next Monday. Use a new channel.",
        language: "en",
      });
      expect(result.proposal).not.toHaveProperty("targetValue");
      expect(result.proposal).not.toHaveProperty("channels");
      expect(result.unknowns).toContain("startAt");
    });
    async function parentFixture() {
      return run(async (tx) => {
        const source = await create(tx, scope, "sources", {
          name: "Synthetic fact source",
          status: "active",
          generation: 1,
          authority: "official",
          publicUse: true,
          modelUse: false,
          maxAgeHours: 168,
        });
        const fact = await setFact(tx, scope, {
          key: "orbit.editorial.status",
          value: "available",
          valueType: "text",
          language: "en",
          sourceId: source.id,
          validFrom: new Date(Date.now() - 60000).toISOString(),
          status: "verified",
          publicUse: true,
          modelUse: false,
        });
        const evidence = await retrieve(tx, scope, {
          query: "orbit.editorial.status",
          purpose: "public",
          language: "en",
          at: new Date(),
        });
        const body = "orbit.editorial.status: available";
        const parent = await create(tx, scope, "content", {
          title: "Synthetic main article",
          body,
          type: "blog",
          channel: "blog",
          language: "en",
          evidenceId: (evidence as any).id,
          claims: [{ kind: "fact", factId: fact.id, text: body }],
          status: "reviewed",
          synthetic: true,
          risk: "routine",
          scheduledAt: new Date().toISOString(),
          humanReviewedBodyHash: "must-not-transfer",
        });
        return { parent, source, body };
      });
    }
    it("creates channel adaptations with current evidence and lineage but no approval/schedule", async () => {
      const { parent, body } = await parentFixture();
      const variant = await run((tx) =>
        adaptContent(tx, scope, {
          parentContentId: parent.id,
          version: parent.version,
          title: "Synthetic social variant",
          body,
          channel: "test-social",
        }),
      );
      expect(data(variant)).toMatchObject({
        parentContentId: parent.id,
        parentContentVersion: parent.version,
        status: "draft",
        evidenceId: data(parent).evidenceId,
        synthetic: true,
        duplicateCheck: { classification: "deliberate_channel_adaptation" },
      });
      expect(data(variant)).not.toHaveProperty("scheduledAt");
      expect(data(variant)).not.toHaveProperty("humanReviewedBodyHash");
      await expect(
        run((tx) =>
          adaptContent(tx, scope, {
            parentContentId: parent.id,
            version: parent.version,
            title: "Duplicate",
            body,
            channel: "test-social",
          }),
        ),
      ).rejects.toThrow("EXACT_CHANNEL_DUPLICATE");
      await expect(
        run((tx) =>
          adaptContent(tx, scope, {
            parentContentId: parent.id,
            version: parent.version,
            title: "Repeated claim",
            body: body + " Learn more.",
            channel: "test-social",
          }),
        ),
      ).rejects.toThrow("CLAIM_OVERLAP_DUPLICATE");
    });
    it("blocks stale parent versions and revoked evidence before creating a derivative", async () => {
      const { parent, source, body } = await parentFixture();
      await expect(
        run((tx) =>
          adaptContent(tx, scope, {
            parentContentId: parent.id,
            version: parent.version + 1,
            title: "Stale",
            body,
            channel: "test-social",
          }),
        ),
      ).rejects.toThrow("VERSION_CONFLICT");
      await run((tx) =>
        update(tx, scope, source, {
          ...data(source),
          status: "revoked",
          generation: 2,
        }),
      );
      await expect(
        run((tx) =>
          adaptContent(tx, scope, {
            parentContentId: parent.id,
            version: parent.version,
            title: "Revoked",
            body,
            channel: "test-social",
          }),
        ),
      ).rejects.toThrow("PARENT_EVIDENCE_INVALID");
      expect(await run((tx) => list(tx, scope, "content"))).toHaveLength(1);
    });
  },
);
