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
import { creativeReads, creativeWrites } from "./creative/mcp-tools.ts";
import { readTaskRecord } from "../../platform/tasks/tasks.ts";
import { publishingBackend } from "./publishing/backend.ts";
import { deliveryOf, type Delivery } from "./publishing/delivery-state.ts";

const page = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
const shared = { module: "marketing" };
/**
 * The delivery of the listed content or missions: a mission's status only
 * says its drafts are done, so readers get how far the post really came.
 */
async function deliveries(tx: any, scope: any, kind: string, rows: any[]) {
  const result = new Map<string, Delivery | null>();
  if (!["content", "missions"].includes(kind) || !rows.length) return result;
  const rowsOf = async (k: string) =>
    (
      await tx.entity.findMany({
        where: { projectId: scope.projectId, kind: k },
        orderBy: { createdAt: "asc" },
      })
    ).map((r: any) => ({ id: r.id, ...data(r) }));
  const contents = kind === "content" ? rows.map((r) => ({ id: r.id, ...data(r) })) : await rowsOf("content");
  const publications = await rowsOf("publications");
  const onSocial = (await publishingBackend(tx, scope)) === "social";
  const inactive = ["canceled", "failed", "blocked_dependency"];
  const of = (c: any) => {
    const own = publications.filter((p: any) => p.contentId === c.id);
    return deliveryOf(c, own.find((p: any) => !inactive.includes(p.status)) ?? own.at(-1) ?? null, onSocial);
  };
  for (const row of rows) {
    if (kind === "content") {
      result.set(row.id, of(contents.find((c: any) => c.id === row.id)));
      continue;
    }
    const own = contents.filter((c: any) => c.missionId === row.id);
    const live = own.filter((c: any) => !["rejected", "archived", "deleted"].includes(c.status));
    result.set(row.id, (live.at(-1) ?? own.at(-1)) ? of(live.at(-1) ?? own.at(-1)) : null);
  }
  return result;
}
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
    const delivery = await deliveries(tx, scope, kind, rows.slice(0, args.limit));
    return {
      items: rows.slice(0, args.limit).map((r: any) => {
        const d = data(r);
        return {
          id: r.id,
          version: r.version,
          title: d.title ?? d.name ?? null,
          status: d.status ?? null,
          ...(delivery.has(r.id) ? { delivery: delivery.get(r.id) } : {}),
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
    agent: {
      title: { en: "Campaigns", de: "Kampagnen" },
      summary: { en: "Lists marketing campaigns and their status.", de: "Listet Marketing-Kampagnen und ihren Status." },
    },
    description:
      "List native marketing missions/campaigns and their status. `status` completed only means the drafts are done; `delivery.state` says how far the post came (generated, awaiting_approval, approved, handoff_pending, scheduled, published, failed, canceled). Use orbit_create_task for complete researched campaigns and existing project_status for channels/readiness.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("missions"),
  }),
  readOperation({
    ...shared,
    name: "marketing_content",
    agent: {
      title: { en: "Content drafts", de: "Inhaltsentwürfe" },
      summary: { en: "Lists saved content drafts with previews.", de: "Listet gespeicherte Inhaltsentwürfe mit Vorschau." },
    },
    description:
      "List saved native content drafts and their status, with compact body previews. `status` reviewed only means the text passed review; `delivery.state` says how far the post came.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("content"),
  }),
  readOperation({
    ...shared,
    name: "marketing_performance",
    agent: {
      title: { en: "Performance", de: "Performance" },
      summary: { en: "Reads imported performance measurements.", de: "Liest importierte Performance-Messwerte." },
    },
    description:
      "Read already imported Matomo/Postiz performance measurements; does not run a new external import.",
    permission: PROJECT_READ,
    input: page,
    run: listKind("metrics"),
  }),
];
const writes = [
  approvedOperation({
    riskClass: "W0",
    // Internal only (ADR 0019): an owner may let agents do it without asking.
    mandate: { maxCostMicrosPerAction: 0 },
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
    riskClass: "W0",
    // Internal only (ADR 0019): an owner may let agents do it without asking.
    mandate: { maxCostMicrosPerAction: 0 },
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
    riskClass: "C2",
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
    riskClass: "W2",
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
      // Either task store (platform/tasks/tasks.ts reads both).
      const d = await readTaskRecord(tx, scope, taskId);
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
    riskClass: "C1",
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
      const d = await readTaskRecord(tx, scope, taskId);
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
const allWrites = [...writes, ...creativeWrites];
export const marketingMcpTools = [
  ...reads,
  ...creativeReads,
  ...allWrites.map((w) => w.tool),
];
export const marketingMcpActions = Object.fromEntries(
  allWrites.map((w) => [w.actionType, w.action]),
);
