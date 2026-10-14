import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { create, data, entity, hash } from "../../shared.ts";
import { resolveChannelRules } from "../channel-rules.ts";
import { activePolicy } from "../policy.ts";

/**
 * One post per slot across channels (R76). An assignment with
 * `sharedAcrossChannels` still holds one slot per channel, but the run
 * groups the slots of one requested time (`groupAt`, set at planning; a slot
 * without it is grouped by its own time). The strategy writes one brief per group on
 * the group's strictest channel, one copywriter step writes that brief's
 * text for the strictest channel's rules and the review judges it once.
 * After the review, the draft is copied for the group's other channels
 * (`cloneForChannel`): one content row and one draft-only mission per
 * channel, so slot booking, delivery, the owner's release and the veto
 * window work per channel exactly as before.
 */
export type SharedSlot = {
  channel: string;
  at: string;
  // The requested time of the shared slot this channel's slot belongs to (R76).
  groupAt?: string;
  // The slot the run was given, when scheduling moved the post (veto.ts).
  requestedAt?: string;
  releasedAt?: string;
};

// Same tolerance after the slot as the mission the copywriter creates.
const SLOT_WINDOW_MS = 2 * 3600000;

const iso = (value: string) => new Date(value).toISOString();
const slotKey = (channel: string, at: string) => `${channel}@${iso(at)}`;

/** The requested time a slot is grouped by. */
export const groupOf = (slot: SharedSlot) => iso(slot.groupAt ?? slot.at);

/** Slots still held, grouped by their requested time, in run order. */
export function slotGroups(slots: SharedSlot[]) {
  const groups = new Map<string, SharedSlot[]>();
  for (const slot of slots) {
    if (slot.releasedAt) continue;
    const key = groupOf(slot);
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }
  return [...groups.entries()].map(([at, members]) => ({ at, slots: members }));
}

/**
 * The channel whose rules are strictest: the smallest character limit with
 * the run's media (Telegram sends an image's text as a caption of at most
 * 1,024 characters); an unknown limit counts as none. Ties keep the order
 * given.
 */
export async function strictestChannel(
  tx: DbTx,
  scope: Scope,
  channels: string[],
  contentType: string,
  media: boolean,
) {
  let best = channels[0]!;
  let bestLimit = Infinity;
  for (const channel of channels) {
    const limit =
      (await resolveChannelRules(tx, scope, channel, contentType, media))
        .characterLimit ?? Infinity;
    if (limit < bestLimit) {
      best = channel;
      bestLimit = limit;
    }
  }
  return best;
}

/**
 * The slots the strategy writes briefs for in a shared run: one per group,
 * on the group's strictest channel at that channel's slot, with every
 * channel the post goes to (`sharedChannels`).
 */
export async function sharedBriefSlots(
  tx: DbTx,
  scope: Scope,
  slots: SharedSlot[],
  assignment: { contentType?: unknown; image?: unknown },
) {
  const briefSlots: Array<{
    channel: string;
    at: string;
    sharedChannels: string[];
    // Every channel's own slot in the group, for what an uncovered slot drops.
    members: Array<{ channel: string; at: string }>;
  }> = [];
  for (const group of slotGroups(slots)) {
    const channels = group.slots.map((slot) => slot.channel);
    const primary = await strictestChannel(
      tx,
      scope,
      channels,
      String(assignment.contentType ?? "social"),
      assignment.image === true,
    );
    const slot = group.slots.find((s) => s.channel === primary)!;
    briefSlots.push({
      channel: primary,
      at: slot.at,
      sharedChannels: channels,
      members: group.slots.map((member) => ({
        channel: member.channel,
        at: member.at,
      })),
    });
  }
  return briefSlots;
}

/**
 * The held slots of the group the slot `channel@at` belongs to, itself
 * first. With `includeReleased`, released slots count too (reports read
 * after scheduling gave slots back); a slot moved for its veto window is
 * also found by the time it was given (`requestedAt`), but a slot at
 * exactly that time comes first.
 */
export function groupSlots(
  slots: SharedSlot[],
  channel: string,
  at: string,
  includeReleased = false,
) {
  const held = (slot: SharedSlot) => includeReleased || !slot.releasedAt;
  const same = (value: string | undefined) =>
    Boolean(value) && Date.parse(value!) === Date.parse(at);
  // The slot at exactly this time wins over one that was only given it
  // (`requestedAt`), so a moved slot never takes another slot's place.
  const candidates = slots.filter(
    (slot) => held(slot) && slot.channel === channel,
  );
  const own =
    candidates.find((slot) => same(slot.at)) ??
    candidates.find((slot) => same(slot.requestedAt));
  if (!own) return [];
  return [
    own,
    ...slots.filter(
      (slot) => slot !== own && held(slot) && groupOf(slot) === groupOf(own),
    ),
  ];
}

/**
 * Copies a run draft for another channel's slot of its group (R76): a
 * draft-only mission for that channel and slot (copied from the draft's
 * mission, without its publishing right or revision link) and a content row
 * with byte-identical title, body, claims, evidence, link and image, as a
 * `draft` without any review. `sharedFrom` names the original and its body
 * hash; the caller judges the copy (review.ts `shareDraft`). A channel
 * that cannot carry the image (`imageRefusal`, the check the visual step
 * makes before it attaches one) gets the copy without it, with the reason
 * in `imageSkipped`, as it would in per-channel mode. Returns the existing
 * copy when there is one.
 */
export async function cloneForChannel(
  tx: DbTx,
  scope: Scope,
  original: Awaited<ReturnType<typeof entity>>,
  slot: SharedSlot,
  existing: Array<Awaited<ReturnType<typeof entity>>>,
  imageRefusal: (content: Record<string, any>) => Promise<string | null>,
) {
  const found = existing.find(
    (row) =>
      data(row).sharedFrom?.contentId === original.id &&
      data(row).channel === slot.channel,
  );
  if (found) return found;
  const v = data(original);
  const missionRow = await entity(tx, scope, "missions", v.missionId);
  const {
    publishAuthorizedBy: _right,
    revisionOf: _revision,
    ...m
  } = data(missionRow);
  const policy = await activePolicy(tx, scope);
  const policyEnd = Date.parse(policy ? data(policy).endAt : "");
  const at = iso(slot.at);
  const mission = await create(tx, scope, "missions", {
    ...m,
    channels: [slot.channel],
    plannedSlotAt: at,
    endAt: new Date(
      Math.max(
        Date.parse(m.endAt),
        Math.min(
          Date.parse(at) + SLOT_WINDOW_MS,
          Number.isFinite(policyEnd) ? policyEnd : Infinity,
        ),
      ),
    ).toISOString(),
    briefKey: slotKey(slot.channel, at),
    agentJobId: `${m.agentJobId ?? missionRow.id}:shared:${slot.channel}`,
    sharedFrom: { missionId: missionRow.id },
  });
  const {
    agentReview: _agentReview,
    agentReviewDecision: _decision,
    review: _review,
    reviewedBy: _reviewedBy,
    humanReviewedBodyHash: _human,
    supersededBy: _supersededBy,
    supersededAt: _supersededAt,
    driveDraft: _driveDraft,
    status: _status,
    ...rest
  } = v;
  const skipped =
    typeof v.assetId === "string"
      ? await imageRefusal({ ...v, channel: slot.channel })
      : null;
  if (skipped) delete rest.assetId;
  return create(tx, scope, "content", {
    ...rest,
    ...(skipped ? { imageSkipped: skipped } : {}),
    channel: slot.channel,
    missionId: mission.id,
    briefKey: slotKey(slot.channel, at),
    scheduledAt: at,
    jobId: `${v.jobId ?? original.id}:shared:${slot.channel}`,
    sharedFrom: {
      contentId: original.id,
      contentVersion: original.version,
      bodyHash: hash(v.body),
    },
    status: "draft",
  });
}
