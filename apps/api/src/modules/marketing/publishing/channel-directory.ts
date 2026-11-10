import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, list } from "../../../shared.ts";
import { socialChannelDirectory } from "../../social/contract.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";

/** One channel a content row may name, as the web shows it. */
export type ChannelEntry = {
  /** The channel reference content carries: a Postiz integration id or `social:<accountId>`. */
  id: string;
  /** The name the owner knows: the Postiz channel's name or the account's handle. */
  name: string | null;
  /** The platform word (Postiz identifier such as `instagram`, or the Social platform). */
  platform: string | null;
  source: "postiz" | "social";
  /** Whether the channel can still be used: assigned and enabled, or a connected account. */
  active: boolean;
};

/**
 * Every channel the project's content can name, with its name and platform
 * (WP3, 2026-11-10): the channels of its Postiz connectors (assigned ones
 * active) and its Social accounts as `social:<accountId>` (disconnected ones
 * inactive, kept so older content still shows a name). Read-only; it reads
 * what the connectors collection and the Social accounts already hold and
 * never returns a credential.
 */
export async function channelDirectory(
  tx: DbTx,
  scope: Scope,
): Promise<ChannelEntry[]> {
  const entries = new Map<string, ChannelEntry>();
  for (const row of await list(tx, scope, "connectors")) {
    const connector = data(row);
    if (connector.provider !== "postiz") continue;
    const assigned = new Set(
      assignedPostizChannels(connector).map((c: { id: string }) => c.id),
    );
    for (const channel of Array.isArray(connector.channels)
      ? connector.channels
      : []) {
      if (typeof channel?.id !== "string") continue;
      const active = assigned.has(channel.id);
      const known = entries.get(channel.id);
      if (known && (known.active || !active)) continue;
      entries.set(channel.id, {
        id: channel.id,
        name: typeof channel.name === "string" ? channel.name : null,
        platform:
          typeof channel.identifier === "string" ? channel.identifier : null,
        source: "postiz",
        active,
      });
    }
  }
  for (const account of await socialChannelDirectory(tx, scope))
    entries.set(account.id, {
      id: account.id,
      name: account.handle,
      platform: account.platform,
      source: "social",
      active: !account.disabled,
    });
  return [...entries.values()];
}
