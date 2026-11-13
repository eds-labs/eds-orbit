import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { authorize, PROJECT_OWN } from "../../../platform/tenancy/permissions.ts";
import { audit, data, DomainError, list } from "../../../shared.ts";
import {
  accountsForMapping,
  mirrorLegacyRows,
  setLegacyChannel,
  type LegacyRow,
  type MappableAccount,
} from "../../social/contract.ts";
import { finalPostText } from "./channel-rules.ts";
import { publishingBackend } from "./backend.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";

// Moving a project from Postiz to Social (ADR 0020, S10): the owner maps
// each of Marketing's Postiz channels to the Social account of the same
// platform. Social resolves Marketing's channels through that mapping (S9);
// a channel stays Postiz-only while it has none.

/** Postiz provider identifiers and the Social platform they publish to. */
const PLATFORM: Record<string, MappableAccount["platform"]> = {
  x: "x",
  facebook: "facebook",
  instagram: "instagram",
  "instagram-standalone": "instagram",
  telegram: "telegram",
};

export type ChannelMapping = {
  integrationId: string;
  name: string;
  platform: MappableAccount["platform"] | null;
  accountId: string | null;
  suggestedAccountId: string | null;
};

/** Marketing's assigned Postiz channels, as the stored connector lists them. */
async function postizChannels(tx: DbTx, scope: Scope) {
  const connector = (await list(tx, scope, "connectors")).find((row) => data(row).provider === "postiz");
  return connector ? (assignedPostizChannels(data(connector)) as Array<{ id: string; name?: string; identifier?: string }>) : [];
}

const plain = (text: string) => text.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]/g, "");

/** The owner's mapping screen: channels, their account (or a suggestion) and the accounts. */
export async function socialMapping(tx: DbTx, scope: Scope) {
  const accounts = await accountsForMapping(tx, scope);
  const channels: ChannelMapping[] = (await postizChannels(tx, scope)).map((channel) => {
    const platform = PLATFORM[String(channel.identifier ?? "")] ?? null;
    const mapped = accounts.find((a) => a.legacyPostizIntegrationId === channel.id);
    const candidates = accounts.filter((a) => a.platform === platform && !a.legacyPostizIntegrationId);
    const byName = candidates.find((a) => plain(a.handle) === plain(String(channel.name ?? "")) || plain(a.displayName) === plain(String(channel.name ?? "")));
    return {
      integrationId: channel.id,
      name: String(channel.name ?? channel.id),
      platform,
      accountId: mapped?.accountId ?? null,
      suggestedAccountId: mapped ? null : (byName?.accountId ?? (candidates.length === 1 ? candidates[0]!.accountId : null)),
    };
  });
  return { backend: await publishingBackend(tx, scope), channels, accounts, inventory: await postizInventory(tx, scope) };
}

/** Maps a Postiz channel to an account, or clears its mapping (`accountId: null`). */
export async function mapPostizChannel(
  tx: DbTx,
  scope: Scope,
  input: { integrationId: string; accountId: string | null },
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const channel = (await postizChannels(tx, scope)).find((c) => c.id === input.integrationId);
  if (!channel) throw new DomainError("POSTIZ_CHANNEL_NOT_FOUND", 404);
  const accounts = await accountsForMapping(tx, scope);
  const current = accounts.find((a) => a.legacyPostizIntegrationId === input.integrationId);
  if (input.accountId === null) {
    if (!current) return socialMapping(tx, scope);
    // Marketing resolves its channels through the mapping while on Social.
    if ((await publishingBackend(tx, scope)) === "social") throw new DomainError("SOCIAL_MAPPING_IN_USE", 409);
    await setLegacyChannel(tx, scope, current.accountId, null);
  } else {
    const account = accounts.find((a) => a.accountId === input.accountId);
    if (!account) throw new DomainError("NOT_FOUND", 404);
    if (account.platform !== PLATFORM[String(channel.identifier ?? "")])
      throw new DomainError("SOCIAL_MAPPING_PLATFORM_MISMATCH", 409);
    if (current && current.accountId !== account.accountId) throw new DomainError("SOCIAL_MAPPING_TAKEN", 409);
    if (account.legacyPostizIntegrationId && account.legacyPostizIntegrationId !== input.integrationId)
      throw new DomainError("SOCIAL_MAPPING_TAKEN", 409);
    await setLegacyChannel(tx, scope, account.accountId, input.integrationId);
  }
  await audit(tx, scope, "marketing.social_channel_mapped", scope.projectId, {
    integrationId: input.integrationId,
    accountId: input.accountId,
  });
  return socialMapping(tx, scope);
}

/** Marketing's publication states and what the mirror shows in Social. */
const MIRRORED: Record<string, LegacyRow["status"]> = {
  published: "published",
  failed: "failed",
  canceled: "canceled",
  outcome_unknown: "outcome_unknown",
  // Handed to Postiz and not settled: Postiz has it.
  scheduled_remote: "accepted",
  sending: "accepted",
  reconciliation_required: "accepted",
  cancellation_required: "accepted",
};

/**
 * The read-only mirror of the project's Postiz history in Social (S-D8):
 * every publication handed to Postiz and every draft Postiz accepted, on
 * mapped channels. Re-runs update the mirror from the source; the source is
 * never changed. Never handed over, test and Social publications are left out.
 */
export async function mirrorPostizHistory(tx: DbTx, scope: Scope, input: { dryRun: boolean }) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const contents = new Map((await list(tx, scope, "content")).map((row) => [row.id, data(row)]));
  const text = (contentId: string, fallback?: unknown) => {
    const c = contents.get(contentId);
    return c ? finalPostText(String(c.body ?? ""), c.targetUrl) : String(fallback ?? "");
  };
  const rows: LegacyRow[] = [];
  for (const row of await list(tx, scope, "publications")) {
    const p = data(row);
    const status = MIRRORED[String(p.status)];
    if (!status || p.test || p.publishingBackend === "social") continue;
    rows.push({
      kind: "publication",
      id: row.id,
      channel: String(p.channel),
      text: text(String(p.contentId)),
      status,
      at: String(p.scheduledAt),
      externalPostId: typeof p.remoteId === "string" ? p.remoteId : null,
      permalink: typeof p.releaseUrl === "string" ? p.releaseUrl : null,
      publishedAt: status === "published" ? String(p.completedAt ?? p.reconciledAt ?? p.scheduledAt) : null,
    });
  }
  for (const row of await list(tx, scope, "postiz_drafts")) {
    const h = data(row);
    if (h.status !== "accepted" || h.publishingBackend === "social") continue;
    rows.push({
      kind: "draft",
      id: row.id,
      channel: String(h.integrationId),
      text: text(String(h.contentId), h.body),
      status: "draft",
      at: String(h.slotAt ?? h.remoteDate ?? row.createdAt.toISOString()),
      externalPostId: typeof h.remoteId === "string" ? h.remoteId : null,
      permalink: null,
      publishedAt: null,
    });
  }
  const result = await mirrorLegacyRows(tx, scope, rows, input);
  if (!input.dryRun)
    await audit(tx, scope, "marketing.postiz_history_mirrored", scope.projectId, {
      created: result.created,
      updated: result.updated,
      unmapped: result.unmapped,
    });
  return result;
}

// Publication and draft states Postiz has not settled: the switch waits for them.
const UNSETTLED = ["sending", "scheduled_remote", "outcome_unknown", "reconciliation_required", "cancellation_required"];
const UNSETTLED_DRAFTS = ["sending", "outcome_unknown"];

const countBy = (values: string[]) =>
  values.reduce<Record<string, number>>((all, v) => ({ ...all, [v]: (all[v] ?? 0) + 1 }), {});

/**
 * How many publications and drafts Postiz still holds unsettled: what the
 * switch to Social waits for (§9.6 step 4), what a drain is finishing and
 * what the queue watch keeps an eye on. A count only; test and Social
 * records do not count. Reads only rows in an unsettled state.
 */
export async function postizBacklog(tx: DbTx, scope: Scope): Promise<number> {
  const unsettled = async (kind: string, statuses: string[]) =>
    (
      await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind,
          OR: statuses.map((status) => ({ data: { path: ["status"], equals: status } })),
        },
        select: { data: true },
      })
    ).map((row) => data(row));
  const publications = (await unsettled("publications", UNSETTLED)).filter((p) => !p.test && p.publishingBackend !== "social");
  const drafts = (await unsettled("postiz_drafts", UNSETTLED_DRAFTS)).filter((h) => h.publishingBackend !== "social");
  return publications.length + drafts.length;
}

/**
 * What the project still has with Postiz (spec §9.2), counts only: no
 * texts, no tokens, no names. The switch to Social is safe once nothing is
 * unsettled (§9.6 step 4).
 */
export async function postizInventory(tx: DbTx, scope: Scope) {
  const publications = (await list(tx, scope, "publications"))
    .map((row) => data(row))
    .filter((p) => !p.test && p.publishingBackend !== "social");
  const drafts = (await list(tx, scope, "postiz_drafts"))
    .map((row) => data(row))
    .filter((h) => h.publishingBackend !== "social");
  const channels = await postizChannels(tx, scope);
  const accounts = await accountsForMapping(tx, scope);
  const exceptions = (await list(tx, scope, "exceptions"))
    .map((row) => data(row))
    .filter((e) => e.status === "open" && /^(POSTIZ_|REMOTE_|PUBLISH_OUTCOME_UNKNOWN|RECONCILIATION_)/.test(String(e.code)));
  const blockingSwitch = await postizBacklog(tx, scope);
  return {
    backend: await publishingBackend(tx, scope),
    channels: {
      assigned: channels.length,
      mapped: channels.filter((c) => accounts.some((a) => a.legacyPostizIntegrationId === c.id)).length,
    },
    publications: countBy(publications.map((p) => String(p.status))),
    postizDrafts: countBy(drafts.map((h) => String(h.status))),
    openExceptions: countBy(exceptions.map((e) => String(e.code))),
    blockingSwitch,
    readyToSwitch: blockingSwitch === 0,
  };
}

/**
 * Why the project cannot switch to Social yet (empty when it can): every
 * assigned channel must be one Social has and be mapped, and Postiz must
 * hold nothing unsettled (spec §9.6 step 4). The server enforces it; the
 * panel only shows it.
 */
export async function switchBlockers(tx: DbTx, scope: Scope): Promise<string[]> {
  const view = await socialMapping(tx, scope);
  const reasons: string[] = [];
  if (view.channels.some((c) => !c.platform)) reasons.push("CHANNEL_NOT_IN_SOCIAL");
  if (view.channels.some((c) => c.platform && !c.accountId)) reasons.push("CHANNEL_NOT_MAPPED");
  if (!view.inventory.readyToSwitch) reasons.push("POSTIZ_UNSETTLED");
  return reasons;
}
