import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
  PROJECT_WRITE,
} from "../../../platform/tenancy/permissions.ts";
import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../../packages/config/src/index.ts";
import {
  marketingProfile,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import {
  audit,
  create,
  data,
  DomainError,
  entity,
  hash,
  list,
  update,
} from "../../../shared.ts";
import { chatScoped, conversation } from "../../chat.ts";
import {
  cancelActionRequest,
  createActionRequest,
} from "../../action-requests.ts";
import { currentMarketingProfile } from "../brand/marketing-profile.ts";
import {
  channelTextLength,
  finalPostText,
  resolveChannelRules,
} from "../publishing/channel-rules.ts";
import { lengthRange } from "./post-format.ts";
import { activePolicy } from "../policy/policy.ts";
import { postizDraftsEnabled } from "../publishing/postiz-draft.ts";
import { cancelAssignmentRuns } from "./assignment-runs.ts";
import { assertBannerReady, assignmentBanner } from "./banner.ts";
import { notify } from "./notifications.ts";
import {
  applyConfirmedDelivery,
  withdrawAssignmentPublications,
} from "./veto.ts";

/**
 * Assignments (Orbit Agents): what Orbit pursues for the owner. An assignment
 * is a draft until an owner confirms its exact content (action request
 * `assignment.confirm`); a change to that content returns it to draft, while
 * pausing, resuming and moving the times do not need a new confirmation.
 * This module holds the model, validation and lifecycle only.
 */
const KIND = "assignments";

export function agentsEnabled() {
  return loadConfig().ORBIT_AGENTS === "true";
}

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * The shape of every post of an assignment (R77): length of the body as
 * written (the link Orbit appends is not counted), hashtag count, short
 * paragraphs and the link the posts lead to. Absent means no format, as
 * before R77. Social assignments only.
 */
export const assignmentFormat = z
  .object({
    minChars: z.number().int().min(1).max(4000),
    maxChars: z.number().int().min(1).max(4000),
    hashtags: z
      .object({
        min: z.number().int().min(0).max(10),
        max: z.number().int().min(0).max(10),
      })
      .strict(),
    paragraphs: z.boolean(),
    // The link of every post: one of the profile's official links inside the policy's allowed origins.
    cta: z
      .url({ protocol: /^https$/ })
      .max(500)
      .optional(),
  })
  .strict();
export type AssignmentFormat = z.infer<typeof assignmentFormat>;

export const assignmentSchedule = z
  .object({
    rhythm: z.enum(["daily", "weekly", "once"]),
    // Local weekdays, 0 = Sunday; weekly rhythm only.
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .max(7)
      .transform((days) => [...new Set(days)].sort()),
    // Local times of day in the project's timezone.
    times: z
      .array(time)
      .min(1)
      .max(6)
      .transform((times) => [...new Set(times)].sort()),
    // Local calendar date of a one-off assignment.
    date: z.iso.date().optional(),
    // How long before the slot a run starts to prepare it.
    leadMinutes: z.number().int().min(0).max(4320).default(360),
  })
  .strict();

const assignmentFields = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["one_off", "standing"]),
    schedule: assignmentSchedule,
    contentType: z.enum(["social", "blog", "newsletter", "report"]),
    // A report goes to the owner, not to a channel: empty for `report`, at least one otherwise.
    channels: z.array(z.string().trim().min(1).max(80)).max(4),
    topicFrame: z.string().trim().min(5).max(2000),
    tone: z.string().trim().min(1).max(300).optional(),
    image: z.boolean(),
    styleAssetIds: z.array(z.uuid()).max(10),
    vetoMinutes: z.number().int().min(30).max(1440).default(180),
    monthlyBudgetMicros: z.number().int().min(0).max(10_000_000_000),
    // How approved posts leave Orbit (R73): published after the veto window,
    // or only created as drafts in Postiz at their slot, which the owner
    // publishes himself. Absent means "publish" (rows from before R73).
    delivery: z.enum(["publish", "postiz_draft"]).optional(),
    // One text and one image per slot for all channels (R76). Absent means
    // false: one text per channel, as before R76.
    sharedAcrossChannels: z.boolean().optional(),
    format: assignmentFormat.optional(),
    // A 16:9 banner per slot in the brand style instead of a free image
    // (R78). Absent means the free image as before R78.
    banner: assignmentBanner.optional(),
  })
  .strict();
type Content = z.infer<typeof assignmentFields>;
const CONTENT_KEYS = Object.keys(assignmentFields.shape) as (keyof Content)[];
/**
 * Optional fields a change may clear with an explicit null (R77, R78); an
 * absent field stays unchanged. The chat tool sends them as `clear`.
 */
export const CLEARABLE = ["format", "banner"] as const;

export const assignmentInput = assignmentFields.superRefine((value, ctx) => {
  const { rhythm, weekdays, date } = value.schedule;
  const issue = (path: string[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  if ((value.kind === "one_off") !== (rhythm === "once"))
    issue(
      ["schedule", "rhythm"],
      "A one-off assignment runs once; a standing one repeats",
    );
  if (
    value.contentType === "report"
      ? value.channels.length
      : !value.channels.length
  )
    issue(
      ["channels"],
      value.contentType === "report"
        ? "A report has no channels"
        : "Channels are required",
    );
  if (rhythm === "weekly" && !weekdays.length)
    issue(["schedule", "weekdays"], "A weekly rhythm needs weekdays");
  if (rhythm === "once" && !date)
    issue(["schedule", "date"], "A one-off assignment needs a date");
  if (value.delivery === "postiz_draft" && value.contentType !== "social")
    issue(["delivery"], "Only social posts can be delivered as Postiz drafts");
  if (value.sharedAcrossChannels === true && value.contentType !== "social")
    issue(
      ["sharedAcrossChannels"],
      "Only social posts can share one text across channels",
    );
  if (value.banner && value.contentType !== "social")
    issue(["banner"], "Only social posts have a banner");
  if (value.banner && !value.image)
    issue(["banner"], "A banner needs the image consent (image: true)");
  if (value.format) {
    if (value.contentType !== "social")
      issue(["format"], "Only social posts have a format");
    if (value.format.minChars > value.format.maxChars)
      issue(["format", "minChars"], "minChars must not exceed maxChars");
    if (value.format.hashtags.min > value.format.hashtags.max)
      issue(["format", "hashtags", "min"], "min must not exceed max");
  }
});
export type AssignmentInput = z.output<typeof assignmentInput>;

export type Delivery = "publish" | "postiz_draft";
/** Preflight blocker for any publication of a draft-delivery assignment's content (R73). */
export const ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS =
  "ASSIGNMENT_DELIVERS_POSTIZ_DRAFTS";
/** The delivery of an assignment; a row without one (from before R73) publishes. */
export const deliveryOf = (source: Record<string, any> | null | undefined) =>
  (source?.delivery === "postiz_draft"
    ? "postiz_draft"
    : "publish") as Delivery;

/**
 * The delivery the owner confirmed (R73), null without a confirmation. It is
 * recorded with the confirmation; a confirmation without it confirmed the
 * row's delivery if its hash still matches the row (the hash covers the
 * delivery), else it is from before R73 and confirmed "publish". An
 * unconfirmed change of the live row never changes it.
 */
export function confirmedDelivery(
  source: Record<string, any> | null | undefined,
): Delivery | null {
  const confirmation = source?.confirmation;
  if (!confirmation || typeof confirmation !== "object") return null;
  if (
    confirmation.delivery === "publish" ||
    confirmation.delivery === "postiz_draft"
  )
    return confirmation.delivery;
  return confirmation.assignmentHash === assignmentHash(source!)
    ? deliveryOf(source)
    : "publish";
}

/** Whether an assignment writes one text and one image per slot for all its channels (R76). */
export const sharedAcrossChannels = (
  source: Record<string, any> | null | undefined,
) => source?.sharedAcrossChannels === true && source?.contentType === "social";

// Field values that equal the behaviour before the field existed; the hash leaves them out.
const LEGACY_DEFAULTS: Partial<Record<keyof Content, unknown>> = {
  delivery: "publish",
  sharedAcrossChannels: false,
};

// Normalized as stored (JSON drops undefined), so a hash is the same before
// and after saving. Defaults that keep the old behaviour (delivery "publish",
// R73; sharedAcrossChannels false, R76; no format, R77; no banner, R78) are left out, so rows
// from before them keep their hash and confirmation, while any other value
// changes it.
const contentOf = (source: Record<string, any>) =>
  JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        CONTENT_KEYS.map((key) => [
          key,
          key in LEGACY_DEFAULTS && source[key] === LEGACY_DEFAULTS[key]
            ? undefined
            : source[key],
        ]),
      ),
    ),
  ) as Record<string, any>;
/** Everything the owner confirms: all content fields, never status, confirmation or versions. */
export const assignmentHash = (source: Record<string, any>) =>
  hash(contentOf(source));
const withoutTimes = (source: Record<string, any>) => {
  const content = contentOf(source);
  return { ...content, schedule: { ...content.schedule, times: [] } };
};

/** Monthly budget the confirmed assignments hold, without `selfId`; drafts claim theirs when confirmed. */
async function committedBudget(tx: DbTx, scope: Scope, selfId: string | null) {
  return (await list(tx, scope, KIND))
    .filter(
      (row) =>
        row.id !== selfId &&
        ["active", "paused", "budget_exhausted"].includes(data(row).status),
    )
    .reduce((sum, row) => sum + Number(data(row).monthlyBudgetMicros ?? 0), 0);
}

/**
 * Report assignments have no delivery yet: nothing sends a run's findings to
 * the bot or the chat, so a report would cost money and deliver nothing
 * (R70, I6). They are refused wherever an assignment is proposed, changed,
 * confirmed or resumed, until a report delivery exists.
 */
export const REPORT_NOT_AVAILABLE = "REPORT_NOT_AVAILABLE";
/** The format's link is not one of the marketing profile's official links (R77). */
export const FORMAT_CTA_NOT_OFFICIAL_LINK = "FORMAT_CTA_NOT_OFFICIAL_LINK";

/**
 * The format's link (R77) must be allowed by the policy and be one of the
 * marketing profile's official links, which carry the verified fact the
 * copywriter's link check needs.
 */
async function assertFormatLink(
  tx: DbTx,
  scope: Scope,
  cta: string | undefined,
  allowedOrigins: string[],
) {
  if (!cta) return;
  let origin: string | null = null;
  try {
    origin = new URL(cta).origin;
  } catch {
    origin = null;
  }
  if (!origin || !allowedOrigins.includes(origin))
    throw new DomainError("LINK_NOT_ALLOWED", 409);
  const profileRow = await currentMarketingProfile(tx, scope);
  const profile = profileRow
    ? marketingProfile.safeParse(profileRow.data)
    : null;
  if (
    !profile?.success ||
    !profile.data.officialLinks.some((link) => link.url === cta)
  )
    throw new DomainError(FORMAT_CTA_NOT_OFFICIAL_LINK, 409);
}

/** The format's longest body plus a newline and its link exceeds a channel's limit (R77). */
export const FORMAT_EXCEEDS_CHANNEL_LIMIT = "FORMAT_EXCEEDS_CHANNEL_LIMIT";

/**
 * A format must fit every channel (R77): its longest accepted body
 * (`maxChars` + 5 %, `lengthRange`) plus a newline and the link Orbit
 * appends, counted as each channel counts it (X weighted with its URL
 * allowance, Telegram in UTF-16 units) with the image when the assignment
 * has one (Telegram's 1,024-character caption), must stay within the
 * smallest limit. The link is the format's, else the longest official link
 * the policy allows. A channel without a known limit is not checked.
 */
async function assertFormatFits(
  tx: DbTx,
  scope: Scope,
  content: Content,
  allowedOrigins: string[],
) {
  if (!content.format) return;
  let link = content.format.cta ?? "";
  if (!link) {
    const profileRow = await currentMarketingProfile(tx, scope);
    const profile = profileRow
      ? marketingProfile.safeParse(profileRow.data)
      : null;
    for (const official of profile?.success ? profile.data.officialLinks : []) {
      let origin: string | null = null;
      try {
        origin = new URL(official.url).origin;
      } catch {
        origin = null;
      }
      if (
        origin &&
        allowedOrigins.includes(origin) &&
        official.url.length > link.length
      )
        link = official.url;
    }
  }
  const text = finalPostText(
    "x".repeat(lengthRange(content.format).max),
    link || null,
  );
  for (const channel of content.channels) {
    const rules = await resolveChannelRules(
      tx,
      scope,
      channel,
      content.contentType,
      content.image === true,
    );
    const length = channelTextLength(text, rules);
    if (
      rules.characterLimit !== null &&
      length !== null &&
      length > rules.characterLimit
    )
      throw new DomainError(FORMAT_EXCEEDS_CHANNEL_LIMIT, 409);
  }
}

async function assertWithinMandate(
  tx: DbTx,
  scope: Scope,
  content: Content,
  selfId: string | null,
) {
  if (content.contentType === "report")
    throw new DomainError(REPORT_NOT_AVAILABLE, 409);
  // Draft delivery needs the Postiz draft handoff switched on (R73).
  if (deliveryOf(content) === "postiz_draft" && !postizDraftsEnabled())
    throw new DomainError("POSTIZ_DRAFTS_DISABLED", 409);
  const policy = await activePolicy(tx, scope);
  if (!policy) throw new DomainError("ACTIVE_POLICY_REQUIRED", 409);
  const mandate = data(policy);
  // Reports are refused above (R70); a report delivery must exempt them from this channel scope again.
  if (
    content.channels.some((channel) => !mandate.channels?.includes(channel)) ||
    !mandate.contentTypes?.includes(content.contentType)
  )
    throw new DomainError("SCOPE_NOT_ALLOWED", 409);
  await assertFormatLink(
    tx,
    scope,
    content.format?.cta,
    mandate.allowedOrigins ?? [],
  );
  await assertFormatFits(tx, scope, content, mandate.allowedOrigins ?? []);
  // A banner is composed with the profile's approved logo, never a generated
  // one, and its wordmark and domain must fit the template (R78).
  if (content.banner)
    await assertBannerReady(
      tx,
      scope,
      content.format?.cta,
      mandate.allowedOrigins ?? [],
    );
  const committed = await committedBudget(tx, scope, selfId);
  if (
    committed + content.monthlyBudgetMicros >
    Number(mandate.monthlyBudgetMicros)
  )
    throw new DomainError("ASSIGNMENT_BUDGET_EXCEEDS_PROJECT", 409);
  for (const assetId of content.styleAssetIds)
    await entity(tx, scope, "assets", assetId);
}

function requireEditor(scope: Scope) {
  authorize(scope, PROJECT_WRITE, "EDITOR_REQUIRED");
}

/** The owner's confirmation request for exactly this content. */
function confirmationRequest(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  content: Content,
) {
  return createActionRequest(tx, scope, {
    actionType: "assignment.confirm",
    payload: {
      assignmentId,
      assignmentHash: assignmentHash(content),
      ...contentOf(content),
    },
    requestedBy: { kind: "agent", userId: scope.userId, agentRunId: null },
  });
}

/** Saves a draft assignment and the owner's confirmation request; nothing runs before it is confirmed. */
export async function proposeAssignment(
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const content = assignmentInput.parse(raw);
  return chatScoped(scope, (tx) =>
    proposeAssignmentInTx(tx, scope, conversationId, content),
  );
}

/** proposeAssignment inside an open chat transaction (`chatScoped`). */
export async function proposeAssignmentInTx(
  tx: DbTx,
  scope: Scope,
  conversationId: string,
  raw: unknown,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const content = assignmentInput.parse(raw);
  await conversation(tx, scope, conversationId);
  await assertWithinMandate(tx, scope, content, null);
  const row = await create(tx, scope, KIND, {
    ...content,
    conversationId,
    status: "draft",
    confirmation: null,
    actionRequestId: null,
  });
  const actionRequest = await confirmationRequest(tx, scope, row.id, content);
  const assignment = await update(tx, scope, row, {
    ...data(row),
    actionRequestId: actionRequest.id,
  });
  await audit(tx, scope, "assignment.proposed", row.id, {
    assignmentHash: assignmentHash(content),
  });
  return { assignment, actionRequest };
}

/** Free share of the project's monthly budget: the policy budget minus what confirmed assignments hold. */
export async function freeAssignmentBudget(tx: DbTx, scope: Scope) {
  const policy = await activePolicy(tx, scope);
  if (!policy) return 0;
  return Math.max(
    0,
    Number(data(policy).monthlyBudgetMicros ?? 0) -
      (await committedBudget(tx, scope, null)),
  );
}

/** Decision check for `assignment.confirm`: the request still describes this draft. */
export async function revalidateAssignmentConfirm(
  tx: DbTx,
  scope: Scope,
  payload: Record<string, unknown>,
) {
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, String(payload.assignmentId));
  const d = data(row);
  if (d.status !== "draft" || assignmentHash(d) !== payload.assignmentHash)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  await assertWithinMandate(
    tx,
    scope,
    assignmentInput.parse(contentOf(d)),
    row.id,
  );
}

/**
 * Executor of `assignment.confirm`: the deciding owner activates exactly the
 * content that was shown. `version` is the assignment version the caller read.
 */
export async function confirmAssignment(
  tx: DbTx,
  scope: Scope,
  assignmentId: string,
  version: number,
  imageRightsConsent = false,
) {
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, assignmentId);
  const d = data(row);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  if (d.status !== "draft") throw new DomainError("ASSIGNMENT_NOT_DRAFT", 409);
  if (d.image === true && imageRightsConsent !== true)
    throw new DomainError("IMAGE_RIGHTS_CONSENT_REQUIRED", 409);
  await assertWithinMandate(
    tx,
    scope,
    assignmentInput.parse(contentOf(d)),
    row.id,
  );
  const saved = await update(tx, scope, row, {
    ...d,
    status: "active",
    confirmation: {
      userId: scope.userId,
      at: new Date().toISOString(),
      assignmentHash: assignmentHash(d),
      imageRightsConsent: d.image === true,
      // The confirmed delivery (R73); the content guard and the runs read it from here.
      delivery: deliveryOf(d),
    },
  });
  await audit(tx, scope, "assignment.confirmed", row.id, {
    assignmentHash: assignmentHash(d),
    imageRightsConsent: d.image === true,
    delivery: deliveryOf(d),
  });
  // Posts and drafts the owner released under the other delivery go (R73).
  await applyConfirmedDelivery(tx, scope, row.id, deliveryOf(d), saved.version);
  return saved;
}

/** Runs on approval of `assignment.confirm`; the open request of the draft is the only one that counts. */
export async function executeAssignmentConfirm(
  tx: DbTx,
  scope: Scope,
  request: { id: string; data: unknown },
) {
  const payload = data(request).payload;
  const row = await entity(tx, scope, KIND, String(payload.assignmentId));
  if (data(row).actionRequestId !== request.id)
    throw new DomainError("ACTION_REQUEST_STALE", 409);
  return confirmAssignment(
    tx,
    scope,
    row.id,
    row.version,
    data(request).decision?.imageRightsConsent === true,
  );
}

/**
 * Changes an assignment. A content change returns it to draft with a new
 * owner request, cancels its open runs and withdraws its scheduled posts
 * that are not handed over (nothing unconfirmed runs or goes out, R70).
 * Moving the times of a confirmed assignment needs no new confirmation; its
 * posts already scheduled were reviewed under the old confirmation and are
 * withdrawn with one notice, and the new times apply from the next run (R22).
 */
export async function updateAssignment(
  tx: DbTx,
  scope: Scope,
  id: string,
  version: number,
  patch: Record<string, unknown>,
) {
  requireEditor(scope);
  if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
  const row = await entity(tx, scope, KIND, id);
  const current = data(row);
  if (current.status === "ended")
    throw new DomainError("ASSIGNMENT_ENDED", 409);
  if (row.version !== version) throw new DomainError("VERSION_CONFLICT", 409);
  const unknown = Object.keys(patch).filter(
    (key) => !CONTENT_KEYS.includes(key as keyof Content),
  );
  if (unknown.length) throw new DomainError("ASSIGNMENT_FIELD_UNKNOWN", 400);
  // An absent field stays as it is; an explicit null clears an optional one.
  const cleared = CLEARABLE.filter((key) => patch[key] === null);
  const merged: Record<string, unknown> = {
    ...contentOf(current),
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
  };
  for (const key of cleared) delete merged[key];
  const next = assignmentInput.parse(merged);
  // The stored row loses a cleared field too.
  const d = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !cleared.includes(key as (typeof CLEARABLE)[number]),
    ),
  ) as Record<string, any>;
  if (assignmentHash(next) === assignmentHash(current)) return row;
  // Moving the times of any assignment is the owner's decision; an editor proposes a content change instead.
  const timesChanged = hash(withoutTimes(next)) === hash(withoutTimes(current));
  if (timesChanged && scope.role !== "owner")
    throw new DomainError("OWNER_REQUIRED", 403);
  await assertWithinMandate(tx, scope, next, id);
  if (timesChanged && d.status !== "draft") {
    // The confirmation covers the unchanged content; its hash follows the new times.
    const saved = await update(tx, scope, row, {
      ...d,
      ...next,
      confirmation: { ...d.confirmation, assignmentHash: assignmentHash(next) },
    });
    await audit(tx, scope, "assignment.times_changed", id);
    const { withdrawn, canceledDrafts } = await withdrawAssignmentPublications(
      tx,
      scope,
      id,
      "ASSIGNMENT_RETIMED",
      { retimedVersion: saved.version },
    );
    if (withdrawn || canceledDrafts)
      await notify(tx, scope, "retimed", `${id}:${saved.version}`);
    return saved;
  }
  if (d.status !== "draft") {
    await cancelAssignmentRuns(tx, scope, id);
    await withdrawAssignmentPublications(tx, scope, id, "ASSIGNMENT_CHANGED");
  }
  if (d.actionRequestId)
    await cancelActionRequest(tx, scope, d.actionRequestId);
  const actionRequest = await confirmationRequest(tx, scope, id, next);
  const saved = await update(tx, scope, row, {
    ...d,
    ...next,
    status: "draft",
    confirmation: null,
    actionRequestId: actionRequest.id,
  });
  await audit(tx, scope, "assignment.content_changed", id, {
    assignmentHash: assignmentHash(next),
  });
  return saved;
}

/**
 * Pause, resume or end. Resuming needs a confirmation that still covers the
 * content. A one-off assignment ends by itself once its run is over
 * (`completedAt`, assignment-runs.ts). `budget_exhausted` is set by the specialist runner (never by a
 * person) when the assignment's budget is used up; it stops like a pause and
 * is resumed the same way. `version`, when given, is the assignment version
 * the person saw (the web page); a change made since then is a conflict.
 */
export async function setAssignmentStatus(
  tx: DbTx,
  scope: Scope,
  id: string,
  status: "active" | "paused" | "ended" | "budget_exhausted",
  version?: number,
) {
  requireEditor(scope);
  const row = await entity(tx, scope, KIND, id);
  const d = data(row);
  // A one-off that ended by completing its run (M2) can still be ended by a
  // person, which withdraws its posts that are not handed over yet.
  const endCompleted =
    status === "ended" &&
    d.status === "ended" &&
    typeof d.completedAt === "string";
  if (d.status === status && !endCompleted) return row;
  if (version !== undefined && row.version !== version)
    throw new DomainError("VERSION_CONFLICT", 409);
  if (d.status === "ended" && !endCompleted)
    throw new DomainError("ASSIGNMENT_ENDED", 409);
  if (status === "active") {
    authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
    if (!agentsEnabled()) throw new DomainError("AGENTS_DISABLED", 409);
    if (
      d.status === "draft" ||
      d.confirmation?.assignmentHash !== assignmentHash(d)
    )
      throw new DomainError("ASSIGNMENT_NOT_CONFIRMED", 409);
    await assertWithinMandate(
      tx,
      scope,
      assignmentInput.parse(contentOf(d)),
      id,
    );
  }
  if (status === "paused" && !["active", "budget_exhausted"].includes(d.status))
    throw new DomainError("ASSIGNMENT_STATUS_INVALID", 409);
  if (status === "budget_exhausted" && d.status !== "active")
    throw new DomainError("ASSIGNMENT_STATUS_INVALID", 409);
  // An open confirmation request dies with the assignment.
  if (status === "ended" && d.actionRequestId)
    await cancelActionRequest(tx, scope, d.actionRequestId);
  const saved = await update(tx, scope, row, {
    ...d,
    status,
    ...(endCompleted ? { completedAt: null } : {}),
  });
  // A stopped assignment must not keep producing: its open runs stop and release their slots,
  // and its scheduled posts that are not handed over yet are withdrawn (R20/R23).
  if (status !== "active") {
    await cancelAssignmentRuns(tx, scope, id);
    await withdrawAssignmentPublications(
      tx,
      scope,
      id,
      status === "ended" ? "ASSIGNMENT_ENDED" : "ASSIGNMENT_PAUSED",
      // The budget notice counts the posts this exhaustion withdrew (M6).
      status === "budget_exhausted"
        ? { budgetPausedVersion: saved.version }
        : {},
    );
  }
  await audit(tx, scope, "assignment.status_changed", id, {
    from: d.status,
    to: status,
  });
  return saved;
}
