import { z } from "zod";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { readModuleSettings, writeModuleSettings } from "../../../platform/modules/settings.ts";
import { authorize, PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { audit, DomainError } from "../../../shared.ts";
import { socialPublishingAvailable } from "../../social/contract.ts";

// Marketing's publishing backend (ADR 0020, S9): Postiz unless the owner
// switches the project to Social. Under Social, Marketing keeps its whole
// pipeline (reviews, approvals, package hash, veto window, preflight) and
// hands a post to Social at its slot instead of to Postiz; assignment
// drafts become Social drafts. Stored in Marketing's ProjectModule row.

export const marketingSettingsSchema = z
  .object({
    /**
     * Where approved posts and assignment drafts go. `postiz_draining`
     * (S10): Postiz finishes what it has, nothing new is handed to it.
     */
    publishingBackend: z.enum(["postiz", "postiz_draining", "social"]),
    /**
     * The owner's per-project switch (plan 2026-11-10): autopilot may
     * release posts through Social without the owner's approval of each
     * package. Absent = off; it can be on only on `social`, and leaving
     * Social turns it off.
     */
    socialAutopilot: z.boolean().optional(),
  })
  .strict();
export type MarketingSettings = z.infer<typeof marketingSettingsSchema>;
export type PublishingBackend = MarketingSettings["publishingBackend"];

export const defaultMarketingSettings = (): MarketingSettings => ({ publishingBackend: "postiz" });

export function readMarketingSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "marketing", marketingSettingsSchema, defaultMarketingSettings);
}

/** The project's backend; a project on Social never falls back to Postiz by itself. */
export async function publishingBackend(tx: DbTx, scope: Scope): Promise<PublishingBackend> {
  return (await readMarketingSettings(tx, scope)).settings.publishingBackend;
}

/** Whether the settings let autopilot publish without per-post approval. */
export function autopilotAllowedBy(settings: MarketingSettings): boolean {
  if (settings.publishingBackend === "postiz") return true;
  if (settings.publishingBackend === "social") return settings.socialAutopilot === true;
  // While Postiz drains nothing new may go out without an approval.
  return false;
}

/**
 * Whether autopilot may release posts without the owner's approval of
 * each package on the project's backend: always on Postiz, on Social only
 * with the owner's switch, never while Postiz drains. Policy activation
 * and preflight both ask this, so turning the switch off makes pending
 * autopilot posts wait for an approval.
 */
export async function autopilotAllowedOnBackend(tx: DbTx, scope: Scope): Promise<boolean> {
  return autopilotAllowedBy((await readMarketingSettings(tx, scope)).settings);
}

const socialAutopilotOn = (settings: MarketingSettings) =>
  settings.publishingBackend === "social" && settings.socialAutopilot === true;

/**
 * The owner's change; Social needs the social module on for the project.
 * The settings are replaced as a whole, so an absent `socialAutopilot` is
 * off. The switch turns on only on Social, and leaving Social turns it off.
 */
export async function saveMarketingSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const requested = marketingSettingsSchema.parse(raw);
  const current = (await readMarketingSettings(tx, scope)).settings;
  const before = current.publishingBackend;
  const autopilotBefore = socialAutopilotOn(current);
  if (requested.socialAutopilot === true && requested.publishingBackend !== "social" && !autopilotBefore)
    throw new DomainError("SOCIAL_AUTOPILOT_REQUIRES_SOCIAL", 409);
  const next: MarketingSettings =
    requested.publishingBackend === "social" || requested.socialAutopilot === undefined
      ? requested
      : { ...requested, socialAutopilot: false };
  if (next.publishingBackend === "social" && !(await socialPublishingAvailable(tx, scope)))
    throw new DomainError("SOCIAL_DISABLED", 409);
  // The move needs every channel mapped and Postiz settled (S10, §9.6).
  if (next.publishingBackend === "social" && before !== "social") {
    const { switchBlockers } = await import("./social-migration.ts");
    const reasons = await switchBlockers(tx, scope);
    if (reasons.length) throw new DomainError("PUBLISHING_BACKEND_NOT_READY", 409);
  }
  const saved = await writeModuleSettings(tx, scope, "marketing", marketingSettingsSchema, next, version);
  if (before !== next.publishingBackend)
    await audit(tx, scope, "marketing.publishing_backend_changed", scope.projectId, { from: before, to: next.publishingBackend });
  // Content-free: only whether autopilot may publish through Social.
  if (autopilotBefore !== socialAutopilotOn(next))
    await audit(tx, scope, "marketing.social_autopilot_changed", scope.projectId, { from: autopilotBefore, to: socialAutopilotOn(next) });
  // On Social nobody watches the Postiz queue: its open notices are closed
  // (resolved and audited, never deleted). A rollback to Postiz restarts the
  // watch and reopens nothing; a new failure opens a new notice.
  if (next.publishingBackend === "social") {
    const { resolvePostizQueueNotices, POSTIZ_QUEUE_RETIRED } = await import("./postiz-queue-watch.ts");
    await resolvePostizQueueNotices(tx, scope, POSTIZ_QUEUE_RETIRED);
  }
  return saved;
}

/** Refuses new work for Postiz while the project drains it (S10). */
export async function refuseWhileDraining(tx: DbTx, scope: Scope): Promise<void> {
  if ((await publishingBackend(tx, scope)) === "postiz_draining")
    throw new DomainError("PUBLISHING_BACKEND_DRAINING", 409);
}
