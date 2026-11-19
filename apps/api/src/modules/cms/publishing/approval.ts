import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  cancelActionRequest,
  consumeActionRequest,
  createActionRequest,
  type ActionDefinition,
  type RequestedBy,
} from "../../../platform/governance/action-requests.ts";
import { can } from "../../../platform/tenancy/permissions.ts";
import { audit, data } from "../../../shared.ts";
import { findEntry, lockEntry, notFound, refused, requireVersion, UUID_RE, versionInput } from "../entries/common.ts";
import { getEntry, sitesOf } from "../entries/entries.ts";
import { createRevision } from "../entries/revisions.ts";
import { requireCms } from "../gate.ts";
import { CMS_PUBLISH_DECIDE } from "../permissions.ts";
import { readCmsSettings, type CmsSettings } from "../settings.ts";
import { requirePreflight } from "./preflight.ts";
import { cancelSchedule, queueBatch } from "./publications.ts";
import { PUBLISH_ACTION, UNPUBLISH_ACTION, pendingRequestFor } from "./requests.ts";
import { resolveSchedule, scheduleFields, scheduleZone, type Schedule } from "./schedule-time.ts";

// Approving publications (ADR 0029 §4.6, decision E-4). Publishing,
// updating, scheduling and withdrawing content are W2: public, never covered
// by an agent mandate (ADR 0019 §10). The owner decides, or, with the
// project setting `publishApprovers: owner_or_editor` (the default), also a
// member with the editor role in the module; `fourEyes` keeps the requester
// from deciding their own request. A member who may decide publishes
// directly; anyone else's request (and every agent, API key or MCP client's)
// waits in Decisions. The approval binds the immutable revision (content
// hash), the sites and the time.

export { PUBLISH_ACTION, UNPUBLISH_ACTION } from "./requests.ts";

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const decision = {
  requesterId: z.string().min(1),
  /** The settings when the request was made: they decide who sees it in Decisions. */
  approvers: z.enum(["owner", "owner_or_editor"]),
  fourEyes: z.boolean(),
};

const publishPayload = z
  .object({
    entryId: z.uuid(),
    type: z.string(),
    locale: z.string(),
    title: z.string(),
    slug: z.string(),
    revisionId: z.uuid(),
    revisionNumber: z.int().min(1),
    contentHash: hex64,
    /** The live revision when asked: a publication in between makes the request stale. */
    previousRevisionId: z.uuid().nullable(),
    siteIds: z.array(z.uuid()).min(1).max(20),
    schedule: z
      .object({ mode: z.enum(["now", "at"]), at: z.string().nullable(), local: z.string().nullable(), timeZone: z.string() })
      .strict(),
    ...decision,
  })
  .strict();
export type PublishPayload = z.infer<typeof publishPayload>;

const unpublishPayload = z
  .object({
    entryId: z.uuid(),
    type: z.string(),
    locale: z.string(),
    title: z.string(),
    slug: z.string(),
    previousRevisionId: z.uuid(),
    siteIds: z.array(z.uuid()).max(20),
    replacementEntryId: z.uuid().nullable(),
    ...decision,
  })
  .strict();
export type UnpublishPayload = z.infer<typeof unpublishPayload>;

type Decidable = { requesterId: string; approvers: CmsSettings["publishApprovers"]; fourEyes: boolean };

const stale = (reason: string) => refused("CMS_REQUEST_STALE", 409, { reason });

/** Whether the member may decide under the given rules (role in the module already applied). */
function allowedBy(member: Scope, rules: Decidable) {
  if (!can(member, CMS_PUBLISH_DECIDE)) return false;
  if (rules.approvers === "owner" && member.role !== "owner") return false;
  return !(rules.fourEyes && member.userId === rules.requesterId);
}

/** The current settings decide, not those the request was made under. */
async function requireDecider(tx: DbTx, scope: Scope, requesterId: string) {
  const { settings } = await readCmsSettings(tx, scope);
  if (!allowedBy(scope, { requesterId, approvers: settings.publishApprovers, fourEyes: settings.fourEyes }))
    throw refused("CMS_DECIDER_NOT_ALLOWED", 403);
}

const sameSites = async (tx: DbTx, scope: Scope, entryId: string, siteIds: readonly string[]) =>
  (await sitesOf(tx, scope, entryId)).sort().join() === [...siteIds].sort().join();

async function checkPublish(tx: DbTx, scope: Scope, payload: PublishPayload) {
  const entry = await findEntry(tx, scope, payload.entryId);
  if (entry.archivedAt) throw stale("archived");
  if (entry.publishedRevisionId !== payload.previousRevisionId) throw stale("published_since");
  const revision = await tx.cmsRevision.findFirst({ where: { id: payload.revisionId, projectId: scope.projectId, entryId: entry.id } });
  if (!revision || revision.contentHash !== payload.contentHash) throw stale("revision");
  if (!(await sameSites(tx, scope, entry.id, payload.siteIds))) throw stale("sites");
  if (payload.schedule.mode === "at") {
    const { settings } = await readCmsSettings(tx, scope);
    if (Date.parse(payload.schedule.at!) < Date.now() - settings.lateWindowHours * 3_600_000)
      throw refused("CMS_SCHEDULE_PASSED", 409);
  }
  await requirePreflight(tx, scope, entry, revision, payload.siteIds);
  return { entry, revision };
}

async function checkUnpublish(tx: DbTx, scope: Scope, payload: UnpublishPayload) {
  const entry = await findEntry(tx, scope, payload.entryId);
  if (entry.publishedRevisionId !== payload.previousRevisionId) throw stale("published_since");
  if (!(await sameSites(tx, scope, entry.id, payload.siteIds))) throw stale("sites");
  if (payload.replacementEntryId) await requireReplacement(tx, scope, entry, payload.replacementEntryId);
  return entry;
}

/** A replacement is another live entry of the same type and locale. */
async function requireReplacement(tx: DbTx, scope: Scope, entry: { id: string; type: string; locale: string }, id: string) {
  const replacement = UUID_RE.test(id) ? await tx.cmsEntry.findFirst({ where: { id, projectId: scope.projectId } }) : null;
  if (!replacement || replacement.id === entry.id || replacement.type !== entry.type || replacement.locale !== entry.locale || !replacement.publishedRevisionId)
    throw refused("CMS_REPLACEMENT_INVALID", 422);
}

const scheduledAtOf = (schedule: PublishPayload["schedule"]) => (schedule.mode === "at" ? new Date(schedule.at!) : null);

async function applyPublish(tx: DbTx, scope: Scope, payload: PublishPayload, requestId: string | null) {
  const entry = await lockEntry(tx, scope, payload.entryId);
  await checkPublish(tx, scope, payload);
  const publications = await queueBatch(tx, scope, entry, {
    kind: "publish",
    revisionId: payload.revisionId,
    siteIds: payload.siteIds,
    scheduledAt: scheduledAtOf(payload.schedule),
    approvalRequestId: requestId,
    requesterId: payload.requesterId,
  });
  await audit(tx, scope, "cms.publication.approved", entry.id, {
    channel: requestId ? "request" : "direct",
    ...(requestId ? { requestId } : {}),
    revision: payload.revisionNumber,
    mode: payload.schedule.mode,
    sites: payload.siteIds.length,
  });
  return publications;
}

async function applyUnpublish(tx: DbTx, scope: Scope, payload: UnpublishPayload, requestId: string | null) {
  const entry = await lockEntry(tx, scope, payload.entryId);
  await checkUnpublish(tx, scope, payload);
  const publications = await queueBatch(tx, scope, entry, {
    kind: "unpublish",
    revisionId: null,
    siteIds: payload.siteIds,
    scheduledAt: null,
    approvalRequestId: requestId,
    requesterId: payload.requesterId,
    replacementEntryId: payload.replacementEntryId,
  });
  await audit(tx, scope, "cms.withdrawal.approved", entry.id, {
    channel: requestId ? "request" : "direct",
    ...(requestId ? { requestId } : {}),
    replacement: Boolean(payload.replacementEntryId),
  });
  return publications;
}

function base<P extends Decidable>(payload: z.ZodType<P>) {
  return {
    riskClass: "W2" as const,
    approvalMode: "approval_required" as const,
    deciderRole: "editor" as const,
    inbox: "editors" as const,
    // Spends nothing; publishing needs no Marketing policy.
    policyRequired: false,
    requires: [] as const,
    ttlMs: 7 * 86_400_000,
    payload,
    costCeilingMicros: () => 0,
    mayDecide: (member: Scope, p: P) => allowedBy(member, p),
  };
}

const publishDefinition: ActionDefinition<PublishPayload> = {
  ...base(publishPayload),
  summary: (p) => ({
    operation: {
      kind: "cms_publish",
      entryId: p.entryId,
      type: p.type,
      locale: p.locale,
      title: p.title,
      slug: p.slug,
      revision: p.revisionNumber,
      update: p.previousRevisionId !== null,
      siteIds: p.siteIds,
      schedule: p.schedule,
    },
  }),
  async revalidate(tx, scope, payload) {
    await requireCms(tx, scope);
    await requireDecider(tx, scope, payload.requesterId);
    await checkPublish(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    const d = data(request);
    const payload = publishPayload.parse(d.payload);
    await consumeActionRequest(tx, scope, request.id, `cms-publish:${request.id}`, d.packageHash);
    await applyPublish(tx, scope, payload, request.id);
  },
};

const unpublishDefinition: ActionDefinition<UnpublishPayload> = {
  ...base(unpublishPayload),
  summary: (p) => ({
    operation: {
      kind: "cms_unpublish",
      entryId: p.entryId,
      type: p.type,
      locale: p.locale,
      title: p.title,
      slug: p.slug,
      siteIds: p.siteIds,
      replacementEntryId: p.replacementEntryId,
    },
  }),
  async revalidate(tx, scope, payload) {
    await requireCms(tx, scope);
    await requireDecider(tx, scope, payload.requesterId);
    await checkUnpublish(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    const d = data(request);
    const payload = unpublishPayload.parse(d.payload);
    await consumeActionRequest(tx, scope, request.id, `cms-unpublish:${request.id}`, d.packageHash);
    await applyUnpublish(tx, scope, payload, request.id);
  },
};

/** The content module's action types (registered through its contributions). */
export const cmsActionTypes: Record<string, ActionDefinition<any>> = {
  [PUBLISH_ACTION]: publishDefinition,
  [UNPUBLISH_ACTION]: unpublishDefinition,
};

// --- Asking -----------------------------------------------------------------

const publishInput = z
  .object({
    /** Publish this revision (reschedule, roll back); else a revision of the current draft. */
    revisionId: z.uuid().optional(),
    /** The draft version the member saw (new revision only). */
    draftVersion: versionInput.optional(),
    changeNote: z.string().max(300).optional(),
    ...scheduleFields,
  })
  .strict();

const unpublishInput = z
  .object({ version: versionInput, replacementEntryId: z.uuid().nullable().optional() })
  .strict();

async function refuseWhilePending(tx: DbTx, scope: Scope, entryId: string) {
  const pending = await pendingRequestFor(tx, scope, entryId);
  if (pending) throw refused("CMS_REQUEST_PENDING", 409, { requestId: pending.id });
}

async function rulesFor(tx: DbTx, scope: Scope, by: RequestedBy) {
  const { settings } = await readCmsSettings(tx, scope);
  const rules: Decidable = { requesterId: by.userId, approvers: settings.publishApprovers, fourEyes: settings.fourEyes };
  // Only a member acting in Orbit publishes directly; agents and clients propose.
  return { settings, rules, direct: by.kind === "user" && by.userId === scope.userId && allowedBy(scope, rules) };
}

/**
 * Publishes, updates or schedules an entry: a member who may decide does it
 * directly; anyone else asks. Without `revisionId` the current draft becomes
 * a revision first. Returns how it went and the entry.
 */
export async function requestPublication(tx: DbTx, scope: Scope, entryId: string, raw: unknown, by: RequestedBy = { kind: "user", userId: scope.userId }) {
  const input = publishInput.parse(raw ?? {});
  const entry = await lockEntry(tx, scope, entryId);
  if (entry.archivedAt) throw refused("CMS_ENTRY_ARCHIVED", 409);
  await refuseWhilePending(tx, scope, entry.id);
  const revisionId = input.revisionId
    ? input.revisionId
    : (await createRevision(tx, scope, entry.id, { draftVersion: input.draftVersion, changeNote: input.changeNote })).revision.id;
  const revision = await tx.cmsRevision.findFirst({ where: { id: revisionId, projectId: scope.projectId, entryId: entry.id } });
  if (!revision) throw notFound("CMS_REVISION_NOT_FOUND");
  const { settings, rules, direct } = await rulesFor(tx, scope, by);
  const schedule: Schedule = resolveSchedule(input, await scheduleZone(tx, scope, settings));
  if (revision.id === entry.publishedRevisionId) throw refused("CMS_REVISION_ALREADY_LIVE", 409);
  const siteIds = (await sitesOf(tx, scope, entry.id)).sort();
  await requirePreflight(tx, scope, entry, revision, siteIds);
  const payload: PublishPayload = {
    entryId: entry.id,
    type: entry.type,
    locale: entry.locale,
    title: revision.title,
    slug: revision.slug,
    revisionId: revision.id,
    revisionNumber: revision.number,
    contentHash: revision.contentHash,
    previousRevisionId: entry.publishedRevisionId,
    siteIds,
    schedule: {
      mode: schedule.mode,
      at: schedule.at?.toISOString() ?? null,
      local: schedule.local,
      timeZone: schedule.timeZone,
    },
    ...rules,
  };
  if (direct) {
    const publicationIds = await applyPublish(tx, scope, payload, null);
    return { mode: "direct" as const, requestId: null, publicationIds, ...(await getEntry(tx, scope, entry.id)) };
  }
  const request = await createActionRequest(tx, scope, { actionType: PUBLISH_ACTION, payload, requestedBy: by });
  await audit(tx, scope, "cms.publication.requested", entry.id, { requestId: request.id, revision: revision.number, mode: schedule.mode });
  return { mode: "requested" as const, requestId: request.id, publicationIds: [], ...(await getEntry(tx, scope, entry.id)) };
}

/**
 * Withdraws a live entry (archived; 410 on its paths, or 301 to a
 * replacement): directly for a member who may decide, else as a request.
 */
export async function requestUnpublish(tx: DbTx, scope: Scope, entryId: string, raw: unknown, by: RequestedBy = { kind: "user", userId: scope.userId }) {
  const input = unpublishInput.parse(raw ?? {});
  const entry = await lockEntry(tx, scope, entryId);
  requireVersion(entry.version, input.version);
  if (!entry.publishedRevisionId) throw refused("CMS_ENTRY_NOT_LIVE", 409);
  await refuseWhilePending(tx, scope, entry.id);
  const replacementEntryId = input.replacementEntryId ?? null;
  if (replacementEntryId) await requireReplacement(tx, scope, entry, replacementEntryId);
  const live = await tx.cmsRevision.findFirstOrThrow({ where: { id: entry.publishedRevisionId, projectId: scope.projectId } });
  const { rules, direct } = await rulesFor(tx, scope, by);
  const payload: UnpublishPayload = {
    entryId: entry.id,
    type: entry.type,
    locale: entry.locale,
    title: live.title,
    slug: live.slug,
    previousRevisionId: entry.publishedRevisionId,
    siteIds: (await sitesOf(tx, scope, entry.id)).sort(),
    replacementEntryId,
    ...rules,
  };
  if (direct) {
    const publicationIds = await applyUnpublish(tx, scope, payload, null);
    return { mode: "direct" as const, requestId: null, publicationIds, ...(await getEntry(tx, scope, entry.id)) };
  }
  const request = await createActionRequest(tx, scope, { actionType: UNPUBLISH_ACTION, payload, requestedBy: by });
  await audit(tx, scope, "cms.withdrawal.requested", entry.id, { requestId: request.id });
  return { mode: "requested" as const, requestId: request.id, publicationIds: [], ...(await getEntry(tx, scope, entry.id)) };
}

const cancelInput = z.object({ version: versionInput }).strict();

/**
 * Stops what is waiting for the entry: an open request (withdrawn) and a
 * schedule with its queued publications. Live content stays live.
 */
export async function cancelPublication(tx: DbTx, scope: Scope, entryId: string, raw: unknown) {
  const input = cancelInput.parse(raw ?? {});
  const entry = await lockEntry(tx, scope, entryId);
  requireVersion(entry.version, input.version);
  const pending = await pendingRequestFor(tx, scope, entry.id);
  if (pending) await cancelActionRequest(tx, scope, pending.id, "cms_cancelled", { pendingOnly: true });
  const cancelled = await cancelSchedule(tx, scope, entry);
  if (!pending && !cancelled && !entry.scheduledRevisionId) throw refused("CMS_NOTHING_TO_CANCEL", 409);
  await audit(tx, scope, "cms.publication.cancelled", entry.id, { request: Boolean(pending), publications: cancelled });
  return getEntry(tx, scope, entry.id);
}
