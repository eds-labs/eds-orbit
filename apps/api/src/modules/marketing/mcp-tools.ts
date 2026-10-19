import { mission } from "../../../../../packages/schemas/src/index.ts";
import { validateDraftMission } from "./assistant/proposals.ts";
import { proposeImageRequest } from "./brand/image-requests.ts";
import { imageRequestBrief } from "./brand/image-generation.ts";
import { proposeScheduleInTx } from "./agents/package-schedule.ts";
import { z } from "zod";
import {
  readOperation,
  approvedOperation,
} from "../../platform/tasks/operation-tools.ts";
import {
  PROJECT_READ,
  PROJECT_WRITE,
} from "../../platform/tenancy/permissions.ts";
import { data, entity, DomainError, create, update } from "../../shared.ts";
import { requestContentPackageInTx } from "./agents/content-packages.ts";
import { reviseDeliverable } from "./agents/content-packages.ts";
import { actionPermissions } from "../../platform/tenancy/permissions.ts";

const page = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const shared = { module: "marketing" };
function listKind(kind: string) {
  return async (tx: any, scope: any, args: any) => {
    const rows = await tx.entity.findMany({
      where: {
        projectId: scope.projectId,
        kind,
        ...(args.cursor ? { id: { gt: args.cursor } } : {}),
      },
      orderBy: { id: "asc" },
      take: args.limit + 1,
    });
    return {
      items: rows.slice(0, args.limit).map((r: any) => {
        const d = data(r);
        return {
          id: r.id,
          version: r.version,
          title: d.title ?? d.name ?? null,
          status: d.status ?? null,
          channels: d.channels ?? [],
          body: typeof d.body === "string" ? d.body.slice(0, 2000) : null,
          createdAt: r.createdAt,
        };
      }),
      nextCursor: rows.length > args.limit ? rows[args.limit - 1].id : null,
    };
  };
}
const reads = [
  readOperation({
    ...shared,
    name: "marketing_campaigns",
    description:
      "List native marketing missions/campaigns and their status. Use orbit_create_task for complete researched campaigns and existing project_status for channels/readiness.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("missions"),
  }),
  readOperation({
    ...shared,
    name: "marketing_content",
    description:
      "List saved native content drafts and their status, with compact body previews.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("content"),
  }),
  readOperation({
    ...shared,
    name: "marketing_performance",
    description:
      "Read already imported Matomo/Postiz performance measurements; does not run a new external import.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("metrics"),
  }),
];
const writes = [
  approvedOperation({
    ...shared,
    name: "marketing_create_campaign",
    description:
      "Create a native draft-only campaign from verified fact IDs, approved sources, policy channels and a validated marketing profile. Does not publish or spend by itself.",
    permission: PROJECT_WRITE,
    input: z
      .object({ mission: mission, factIds: z.array(z.uuid()).min(1).max(20) })
      .strict(),
    async run(tx, scope, args) {
      const v = await validateDraftMission(
        tx,
        scope,
        args.mission,
        args.factIds,
      );
      return create(tx, scope, "missions", {
        ...v.parsed,
        status: "draft",
        factKeys: v.verifiedFacts.map((f) => data(f).key),
      });
    },
  }),
  approvedOperation({
    ...shared,
    name: "marketing_update_campaign",
    description:
      "Replace an exact version of a native draft campaign after the same native source/profile/policy validation. Running campaigns must be managed through their existing workflows.",
    permission: PROJECT_WRITE,
    input: z
      .object({
        campaignId: z.uuid(),
        version: z.number().int().positive(),
        mission: mission,
        factIds: z.array(z.uuid()).min(1).max(20),
      })
      .strict(),
    async run(tx, scope, args) {
      const row = await entity(tx, scope, "missions", args.campaignId);
      if (row.version !== args.version || data(row).status !== "draft")
        throw new DomainError("CAMPAIGN_NOT_EDITABLE", 409);
      const v = await validateDraftMission(
        tx,
        scope,
        args.mission,
        args.factIds,
      );
      return update(tx, scope, row, {
        ...v.parsed,
        status: "draft",
        factKeys: v.verifiedFacts.map((f) => data(f).key),
      });
    },
  }),
  approvedOperation({
    ...shared,
    name: "marketing_request_image",
    description:
      "Prepare an image request with the existing image model, configured ceiling and rights controls. The image's own exact prompt/budget approval remains required.",
    permission: PROJECT_WRITE,
    input: imageRequestBrief,
    async run(tx, scope, args, requester) {
      const row = await proposeImageRequest(
        tx,
        scope,
        args,
        requester ?? { kind: "user", userId: scope.userId },
      );
      return { actionRequestId: row.id, status: "pending" };
    },
  }),
  approvedOperation({
    ...shared,
    name: "marketing_schedule_content",
    description:
      "Propose a date for a generated native package deliverable. The resulting exact-content schedule approval retains readiness, evidence, channel verification and publication locks.",
    permission: PROJECT_WRITE,
    input: z
      .object({
        taskId: z.uuid(),
        deliverableKey: z.string().min(1).max(200),
        date: z.string().max(10).optional(),
      })
      .strict(),
    async run(tx, scope, { taskId, ...args }, requester) {
      const task = await entity(tx, scope, "orbit_tasks", taskId);
      const d = data(task);
      if (
        d.userId !== scope.userId ||
        (requester?.kind === "mcp" && d.clientId !== requester.clientId)
      )
        throw new DomainError("NOT_FOUND", 404);
      return proposeScheduleInTx(
        tx,
        scope,
        d.conversationId,
        args,
        requester ?? { kind: "user", userId: scope.userId },
      );
    },
  }),
  approvedOperation({
    ...shared,
    name: "marketing_prepare_package",
    description:
      "Prepare a native content package (social copy and optional artwork) inside this connection's task conversation. The resulting package has its own budgeted start approval; publishing retains its separate exact-content approval and readiness checks.",
    permission: PROJECT_WRITE,
    input: z
      .object({
        taskId: z.uuid(),
        goal: z.string().min(1).max(2000),
        channels: z.array(z.string()).min(1).max(10),
        factKeys: z.array(z.string()).max(30),
        imageBrief: z.string().max(2000).optional(),
        audience: z.string().max(300).optional(),
        campaignType: z.enum(["product", "presale"]).optional(),
      })
      .strict(),
    async run(tx, scope, { taskId, ...args }, requester) {
      const task = await entity(tx, scope, "orbit_tasks", taskId);
      const d = data(task);
      if (
        d.userId !== scope.userId ||
        (requester?.kind === "mcp" && d.clientId !== requester.clientId)
      )
        throw new DomainError("NOT_FOUND", 404);
      const saved = await requestContentPackageInTx(
        tx,
        scope,
        d.conversationId,
        args,
        requester,
      );
      return {
        packageId: saved.package.id,
        actionRequestId: saved.actionRequest.id,
        status: "awaiting_confirmation",
      };
    },
  }),
];
export const marketingMcpTools = [...reads, ...writes.map((w) => w.tool)];
export const marketingMcpActions = Object.fromEntries(
  writes.map((w) => [w.actionType, w.action]),
);
