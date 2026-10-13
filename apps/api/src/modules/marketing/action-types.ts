import { z } from "zod";
import type { ActionDefinition } from "../action-requests.ts";
import { DomainError, data, update } from "../../shared.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import { currentImageTerms, imageRequestPayload } from "../image-generation.ts";
import * as packages from "../agents/content-packages.ts";
import * as schedule from "../agents/package-schedule.ts";
import * as assignments from "../agents/assignments.ts";

/**
 * The action request types marketing contributes (ADR 0008, WP1.6). Moved
 * unchanged from action-requests.ts; the modules they call are imported
 * directly now that the platform no longer has to load them lazily.
 */
const imageGenerate: ActionDefinition<z.infer<typeof imageRequestPayload>> = {
  riskClass: "C2",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 24 * 3600000,
  payload: imageRequestPayload,
  costCeilingMicros: (payload) => payload.maxCostMicros,
  async revalidate(tx, scope, payload) {
    const { imageConfig } = await currentImageTerms(tx, scope);
    if (
      imageConfig.model !== payload.model ||
      imageConfig.maxCostMicrosPerImage !== payload.maxCostMicros
    )
      throw new DomainError("IMAGE_REQUEST_STALE", 409);
  },
  async onApproved(tx, scope, request) {
    const job = await enqueue(
      tx,
      scope,
      "image",
      request.id,
      "action:" + request.id,
    );
    // One paid attempt: an unclear provider outcome is never retried.
    await update(tx, scope, job, { ...data(job), maxAttempts: 1 });
  },
};
// Paid drafts inside the mandate; the user confirms the exact package plan once.
const contentPackageStart: ActionDefinition<Record<string, unknown>> = {
  riskClass: "C1",
  approvalMode: "approval_required",
  deciderRole: "editor",
  ttlMs: 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: (payload) => Number(payload.ceilingMicros),
  async revalidate(tx, scope, payload) {
    await packages.revalidateContentPackage(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    await packages.startContentPackage(tx, scope, request);
  },
};
// A public post at a fixed slot: an owner decides the exact post (ADR 0008, J3.1).
const contentSchedule: ActionDefinition<Record<string, unknown>> = {
  riskClass: "W2",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: () => 0,
  async revalidate(tx, scope, payload) {
    await schedule.revalidateSchedule(
      tx,
      scope,
      schedule.scheduleRequestPayload.parse(payload),
    );
  },
  async onApproved(tx, scope, request) {
    await schedule.executeSchedule(tx, scope, request);
  },
};
// An internal change without public effect: the owner confirms an assignment's exact content.
const assignmentConfirm: ActionDefinition<Record<string, unknown>> = {
  riskClass: "W0_internal",
  approvalMode: "approval_required",
  deciderRole: "owner",
  ttlMs: 7 * 24 * 3600000,
  payload: z.record(z.string(), z.unknown()),
  costCeilingMicros: () => 0,
  async revalidate(tx, scope, payload) {
    await assignments.revalidateAssignmentConfirm(tx, scope, payload);
  },
  async onApproved(tx, scope, request) {
    await assignments.executeAssignmentConfirm(tx, scope, request);
  },
};
export const marketingActionTypes = {
  "image.generate": imageGenerate,
  "content_package.start": contentPackageStart,
  "content.schedule": contentSchedule,
  "assignment.confirm": assignmentConfirm,
};
