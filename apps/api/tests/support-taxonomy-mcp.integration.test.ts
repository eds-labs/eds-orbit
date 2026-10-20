import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import {
  authDb,
  scoped,
  closeDatabase,
} from "../../../packages/db/src/index.ts";
import { createPackageProject } from "./support/package-project.ts";
import { createMailInbox } from "./fixtures/mailbox.ts";
import { createTicket } from "../src/modules/support/tickets.ts";
import { updateTicket } from "../src/modules/support/workspace.ts";
import { updateInbox } from "../src/modules/support/inboxes.ts";
import { readTaxonomySettings } from "../src/modules/support/taxonomy.ts";
import { supportSettingsSchema } from "../src/modules/support/settings.ts";
import { writeModuleSettings } from "../src/platform/modules/settings.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import {
  authorizeMcpCall,
  visibleMcpTools,
} from "../src/platform/mcp/visibility.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import { data, entity } from "../src/shared.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
vi.mock("nodemailer", () => ({
  default: {
    createTransport() {
      throw Error("REAL_SMTP_FORBIDDEN_IN_TEST");
    },
  },
}));
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
describe.skipIf(!enabled)(
  "Support taxonomy MCP (native settings; synthetic only)",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>,
      other: Awaited<ReturnType<typeof createPackageProject>>,
      p: McpPrincipal,
      inboxId: string;
    const saved: Record<string, string | undefined> = {};
    const flags = {
      ORBIT_SUPPORT: "true",
      ORBIT_MODULES: "true",
      ORBIT_MODULE_ROLES: "true",
      ORBIT_MCP_TASKS: "true",
      ORBIT_MCP_PROPOSALS: "true",
      ORBIT_EMAIL: "true",
    };
    const run = <T>(work: Parameters<typeof scoped<T>>[2]) =>
      scoped(project.owner.workspaceId, project.owner.projectId, work);
    async function principal(
      scope: Scope,
      scopes = ["orbit:read", "orbit:propose", "orbit:support"],
    ) {
      const g = await authDb.mcpGrant.create({
        data: {
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          clientId: `https://taxonomy.test/${randomUUID()}.json`,
          projectIds: [scope.projectId],
          modules: [],
          scopes,
          status: "active",
          activatedAt: new Date(),
        },
      });
      return {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: g.clientId,
        grantId: g.id,
        projectIds: [scope.projectId],
        modules: [],
        scopes: new Set(scopes),
      } as McpPrincipal;
    }
    async function call(
      name: string,
      args: object = {},
      by = p,
      projectId = project.owner.projectId,
    ): Promise<any> {
      const { tool, scope } = await authorizeMcpCall(by, name, projectId);
      const result = await tool.execute(
        {
          scope: moduleScope(scope, "support"),
          runId: "synthetic-taxonomy",
          conversationId: "synthetic-taxonomy",
          callIndex: 0,
          channel: {
            kind: "mcp",
            clientId: by.clientId,
            grantId: by.grantId,
            requestId: "synthetic-taxonomy",
          },
        },
        args,
      );
      expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
      return result.output;
    }
    const propose = (name: string, args: object, by = p) =>
      call(`support_${name}`, { ...args, idempotencyKey: randomUUID() }, by);
    async function decide(
      id: string,
      decision: "approve" | "reject" = "approve",
    ) {
      return run(async (tx) => {
        const row = await entity(tx, project.owner, "action_requests", id);
        return decideActionRequest(tx, project.owner, id, {
          version: row.version,
          packageHash: data(row).packageHash,
          decision,
        });
      });
    }
    async function settings(patch: object) {
      return run(async (tx) => {
        const current = await readTaxonomySettings(tx, project.owner);
        return writeModuleSettings(
          tx,
          project.owner,
          "support",
          supportSettingsSchema,
          { ...current.settings, ...patch },
          current.version,
        );
      });
    }
    async function add(kind: "category" | "tag", key: string, label = key) {
      const made = await propose(`create_${kind}`, { key, label });
      await decide(made.actionRequestId);
      return made;
    }
    beforeAll(async () => {
      for (const [k, v] of Object.entries(flags)) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      project = await createPackageProject({ name: "Synthetic taxonomy MCP" });
      other = await createPackageProject({
        name: "Synthetic foreign taxonomy",
      });
      await run(async (tx) => {
        await tx.projectModule.create({
          data: {
            workspaceId: project.owner.workspaceId,
            projectId: project.owner.projectId,
            moduleId: "support",
            moduleVersion: "1.0.0",
            enabled: true,
          },
        });
        inboxId = (
          await createMailInbox(tx, project.owner, {
            name: "Synthetic Support",
            channels: ["email"],
            emailAddress: "support@example.invalid",
            rules: { autoAck: false, mcpOwnerRepliesWithoutApproval: true },
          })
        ).inbox.id;
      });
      p = await principal(project.owner);
    }, 120000);
    afterAll(async () => {
      await project?.cleanup();
      await other?.cleanup();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await closeDatabase();
    });
    it("lists definitions for members and exposes only owner-managed writes", async () => {
      const owner = (await visibleMcpTools(p, project.owner.projectId)).map(
        (t) => t.name,
      );
      for (const kind of ["category", "tag"])
        for (const action of ["create", "update", "delete"])
          expect(owner).toContain(`support_${action}_${kind}`);
      for (const scope of [project.editor, project.viewer]) {
        const member = await principal(scope);
        const names = (await visibleMcpTools(member, scope.projectId)).map(
          (t) => t.name,
        );
        expect(names).toContain("support_list_tags");
        expect(names).not.toContain("support_create_tag");
        expect(
          (await call("support_list_categories", {}, member)).result.items,
        ).toEqual([]);
        await expect(
          propose(
            "create_tag",
            { key: "forbidden", label: "Forbidden" },
            member,
          ),
        ).rejects.toThrow();
      }
    });
    it("queues exact independent proposals, merges batch approvals and replays once even with inbox opt-in", async () => {
      await settings({ autoCloseDays: 17, reopenOnReply: false });
      const key = randomUUID();
      const category = await propose("create_category", {
        key: "billing",
        label: "Billing",
      });
      const tag = await call("support_create_tag", {
        key: "urgent_case",
        label: "Urgent",
        idempotencyKey: key,
      });
      expect(category.requiresApproval).toBe(true);
      expect(tag.requiresApproval).toBe(true);
      expect((await call("support_list_tags")).result.items).toEqual([]);
      await decide(category.actionRequestId);
      await decide(tag.actionRequestId);
      expect(
        (await call("support_list_categories")).result.items,
      ).toContainEqual({ key: "billing", label: "Billing" });
      expect((await call("support_list_tags")).result.items).toContainEqual({
        key: "urgent_case",
        label: "Urgent",
        color: "gray",
      });
      const before = await run((tx) => readTaxonomySettings(tx, project.owner));
      expect(before.settings).toMatchObject({
        autoCloseDays: 17,
        reopenOnReply: false,
      });
      const retry = await call("support_create_tag", {
        key: "urgent_case",
        label: "Urgent",
        idempotencyKey: key,
      });
      expect(retry).toMatchObject({
        deduplicated: true,
        status: "consumed",
        requiresApproval: false,
      });
      expect(
        (await run((tx) => readTaxonomySettings(tx, project.owner))).version,
      ).toBe(before.version);
      await expect(
        call("support_create_tag", {
          key: "urgent_case",
          label: "Different",
          idempotencyKey: key,
        }),
      ).rejects.toThrow("IDEMPOTENCY_KEY_CONFLICT");
      const batchOne = await propose("create_tag", {
        key: "batch_one",
        label: "First",
      });
      const batchTwo = await propose("create_tag", {
        key: "batch_two",
        label: "Second",
      });
      await decide(batchOne.actionRequestId);
      await decide(batchTwo.actionRequestId);
      expect(
        (await call("support_list_tags")).result.items.map(
          (t: { key: string }) => t.key,
        ),
      ).toEqual(expect.arrayContaining(["batch_one", "batch_two"]));
      expect(
        await run((tx) =>
          tx.supportInbox.findUniqueOrThrow({
            where: { id: inboxId },
            select: { rules: true },
          }),
        ),
      ).toMatchObject({
        rules: { autoAck: false, mcpOwnerRepliesWithoutApproval: true },
      });
      expect(
        await run((tx) =>
          tx.supportMessage.count({
            where: { projectId: project.owner.projectId, kind: "agent_reply" },
          }),
        ),
      ).toBe(0);
    });
    let usedTicketId: string;
    it("renames labels/colours while retaining ticket keys and native settings", async () => {
      usedTicketId = (
        await run((tx) =>
          createTicket(tx, project.owner, {
            inboxId,
            channel: "email",
            inbound: {
              externalId: `<${randomUUID()}@example.invalid>`,
              contact: { email: "customer@example.invalid" },
              subject: "Synthetic category use",
              bodyText: "Plain data",
              attachments: [],
            },
          }),
        )
      ).ticketId;
      await run((tx) =>
        updateTicket(tx, project.owner, usedTicketId, {
          category: "billing",
          tags: ["urgent_case"],
        }),
      );
      const category = await propose("update_category", {
        key: "billing",
        label: "Invoices",
      });
      const tag = await propose("update_tag", {
        key: "urgent_case",
        label: "Priority",
        color: "red",
      });
      await decide(category.actionRequestId);
      await decide(tag.actionRequestId);
      expect((await call("support_list_tags")).result.items).toContainEqual({
        key: "urgent_case",
        label: "Priority",
        color: "red",
      });
      expect(
        (await call("support_list_categories")).result.items,
      ).toContainEqual({ key: "billing", label: "Invoices" });
      expect(
        await run((tx) =>
          tx.supportTicket.findUniqueOrThrow({ where: { id: usedTicketId } }),
        ),
      ).toMatchObject({ category: "billing", tags: ["urgent_case"] });
    });
    it("refuses deletion of ticket/inbox references and rechecks new use at approval", async () => {
      await expect(
        propose("delete_category", { key: "billing" }),
      ).rejects.toThrow("CATEGORY_IN_USE");
      await expect(
        propose("delete_tag", { key: "urgent_case" }),
      ).rejects.toThrow("TAG_IN_USE");
      await add("category", "inbox_default");
      await run(async (tx) => {
        const inbox = await tx.supportInbox.findUniqueOrThrow({
          where: { id: inboxId },
        });
        await updateInbox(tx, project.owner, inboxId, {
          version: inbox.version,
          defaultCategory: "inbox_default",
        });
      });
      await expect(
        propose("delete_category", { key: "inbox_default" }),
      ).rejects.toThrow("CATEGORY_IN_USE_BY_INBOX");
      await add("tag", "later_used");
      const deletion = await propose("delete_tag", { key: "later_used" });
      await run((tx) =>
        updateTicket(tx, project.owner, usedTicketId, {
          tags: ["urgent_case", "later_used"],
        }),
      );
      await expect(decide(deletion.actionRequestId)).rejects.toThrow(
        "TAG_IN_USE",
      );
    });
    it("rejects stale same-key approvals but preserves unrelated edits and supports rejection/deletion", async () => {
      await add("tag", "untouched");
      const stale = await propose("update_tag", {
        key: "untouched",
        label: "Proposed",
      });
      let current = await run((tx) => readTaxonomySettings(tx, project.owner));
      await settings({
        tags: current.settings.tags.map((t) =>
          t.key === "untouched" ? { ...t, label: "Changed elsewhere" } : t,
        ),
      });
      await expect(decide(stale.actionRequestId)).rejects.toThrow(
        "SUPPORT_DEFINITION_CHANGED",
      );
      const valid = await propose("update_tag", {
        key: "untouched",
        color: "blue",
      });
      await settings({ autoCloseDays: 19 });
      await decide(valid.actionRequestId);
      expect(
        (await run((tx) => readTaxonomySettings(tx, project.owner))).settings
          .autoCloseDays,
      ).toBe(19);
      const rejected = await propose("delete_tag", { key: "untouched" });
      await decide(rejected.actionRequestId, "reject");
      expect(
        (await call("support_list_tags")).result.items.some(
          (t: any) => t.key === "untouched",
        ),
      ).toBe(true);
      const deleted = await propose("delete_tag", { key: "untouched" });
      await decide(deleted.actionRequestId);
      expect(
        (await call("support_list_tags")).result.items.some(
          (t: any) => t.key === "untouched",
        ),
      ).toBe(false);
      await add("category", "unused_category");
      const category = await propose("delete_category", {
        key: "unused_category",
      });
      await decide(category.actionRequestId);
      expect(
        (await call("support_list_categories")).result.items.some(
          (t: any) => t.key === "unused_category",
        ),
      ).toBe(false);
    });
    it("validates keys, sizes, colours, duplicates, unknown fields, empty edits and capacity", async () => {
      for (const args of [
        { key: "Bad key", label: "Invalid" },
        { key: "blank", label: " " },
        { key: "too_long", label: "a".repeat(41) },
        { key: "bad_color", label: "Invalid", color: "black" },
        { key: "inject", label: "Invalid", settings: { autoCloseDays: 1 } },
      ])
        await expect(propose("create_tag", args)).rejects.toThrow();
      await expect(
        propose("create_category", { key: "billing", label: "Duplicate" }),
      ).rejects.toThrow("SUPPORT_DEFINITION_EXISTS");
      await expect(
        propose("update_tag", { key: "urgent_case" }),
      ).rejects.toThrow("SUPPORT_DEFINITION_CHANGE_REQUIRED");
      await expect(
        propose("update_category", { key: "not_present", label: "Unknown" }),
      ).rejects.toThrow("SUPPORT_DEFINITION_NOT_FOUND");
      const before = await run((tx) => readTaxonomySettings(tx, project.owner));
      try {
        await settings({
          tags: Array.from({ length: 50 }, (_, i) => ({
            key: `limit_${i}`,
            label: `Limit ${i}`,
            color: "gray",
          })),
        });
        await expect(
          propose("create_tag", { key: "beyond_limit", label: "Too many" }),
        ).rejects.toThrow("SUPPORT_DEFINITION_LIMIT");
      } finally {
        await settings({ tags: before.settings.tags });
      }
    });
    it("rechecks the proposing owner's current role before approval", async () => {
      const pending = await propose("create_tag", {
        key: "demoted_owner",
        label: "Must not save",
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: project.owner.userId,
          role: "editor",
        },
      });
      try {
        await authDb.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId: project.owner.workspaceId,
              userId: project.owner.userId,
            },
          },
          data: { role: "viewer" },
        });
        await expect(decide(pending.actionRequestId)).rejects.toThrow(
          "FORBIDDEN",
        );
      } finally {
        await authDb.workspaceMember.update({
          where: {
            workspaceId_userId: {
              workspaceId: project.owner.workspaceId,
              userId: project.owner.userId,
            },
          },
          data: { role: "owner" },
        });
        await authDb.projectMember.deleteMany({
          where: {
            projectId: project.owner.projectId,
            userId: project.owner.userId,
          },
        });
      }
      expect(
        (await call("support_list_tags")).result.items.some(
          (t: { key: string }) => t.key === "demoted_owner",
        ),
      ).toBe(false);
    });
    it("enforces scope, project, grant, feature and module boundaries", async () => {
      const readOnly = await principal(project.owner, [
        "orbit:read",
        "orbit:support",
      ]);
      await expect(
        propose(
          "create_tag",
          { key: "no_scope", label: "Forbidden" },
          readOnly,
        ),
      ).rejects.toThrow();
      await expect(
        call("support_list_tags", {}, p, other.owner.projectId),
      ).rejects.toThrow();
      const missingContent = await principal(project.owner, [
        "orbit:read",
        "orbit:propose",
      ]);
      await expect(
        call("support_list_tags", {}, missingContent),
      ).rejects.toThrow();
      const revoked = await principal(project.owner);
      const request = await propose(
        "create_tag",
        { key: "revoked", label: "Must not save" },
        revoked,
      );
      await authDb.mcpGrant.update({
        where: { id: revoked.grantId },
        data: { status: "revoked", revokedAt: new Date(), revokedBy: "user" },
      });
      await expect(decide(request.actionRequestId)).rejects.toThrow(
        "MCP_GRANT_ENDED",
      );
      try {
        process.env.ORBIT_SUPPORT = "false";
        await expect(call("support_list_tags")).rejects.toThrow();
      } finally {
        process.env.ORBIT_SUPPORT = "true";
      }
      try {
        process.env.ORBIT_MCP_PROPOSALS = "false";
        await expect(
          propose("create_tag", { key: "disabled", label: "Forbidden" }),
        ).rejects.toThrow();
      } finally {
        process.env.ORBIT_MCP_PROPOSALS = "true";
      }
      await run((tx) =>
        tx.projectModule.updateMany({
          where: { projectId: project.owner.projectId, moduleId: "support" },
          data: { enabled: false },
        }),
      );
      try {
        await expect(call("support_list_tags")).rejects.toThrow();
      } finally {
        await run((tx) =>
          tx.projectModule.updateMany({
            where: { projectId: project.owner.projectId, moduleId: "support" },
            data: { enabled: true },
          }),
        );
      }
      expect(
        (await call("support_list_tags")).result.items.some((t: any) =>
          ["revoked", "disabled", "no_scope"].includes(t.key),
        ),
      ).toBe(false);
    });
  },
);
