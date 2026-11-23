import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { WebmailUnreadSummary } from "../../../../../packages/schemas/src/webmail-inbox.ts";
import { readMailboxUnread } from "../../platform/email/shared-client.ts";

type Target = { mailboxId: string; connectionId: string; available: boolean };
type Reader = { scope: Scope; mailboxes: Target[] };
type Cached = { until: number; count: Promise<number | null> };

const counts = new Map<string, Cached>();
const TTL_MS = 30_000;
const MAILBOX_BATCH = 4;
const keyFor = (scope: Scope, id: string) =>
  `${scope.workspaceId}:${scope.projectId}:${id}`;

function cache(key: string, entry: Cached) {
  counts.delete(key);
  if (counts.size >= 512) counts.delete(counts.keys().next().value!);
  counts.set(key, entry);
}

export function rememberUnread(
  scope: Scope,
  connectionId: string,
  count: number,
) {
  cache(keyFor(scope, connectionId), {
    until: Date.now() + TTL_MS,
    count: Promise.resolve(count),
  });
}

function countMailbox(scope: Scope, target: Target): Promise<number | null> {
  if (!target.available) return Promise.resolve(null);
  const key = keyFor(scope, target.connectionId);
  const existing = counts.get(key);
  if (existing && existing.until > Date.now()) return existing.count;
  const entry: Cached = {
    until: Number.POSITIVE_INFINITY,
    count: readMailboxUnread(scope, target.connectionId).catch(() => null),
  };
  cache(key, entry);
  void entry.count.then((count) => {
    entry.until = Date.now() + (count === null ? 5_000 : TTL_MS);
  });
  return entry.count;
}

export async function aggregateUnread(
  authorize: () => Promise<Reader>,
): Promise<WebmailUnreadSummary> {
  const { scope, mailboxes } = await authorize();
  const observed = new Map<
    string,
    { connectionId: string; value: number | null }
  >();
  for (let i = 0; i < mailboxes.length; i += MAILBOX_BATCH) {
    await Promise.all(
      mailboxes.slice(i, i + MAILBOX_BATCH).map(async (target) => {
        observed.set(target.mailboxId, {
          connectionId: target.connectionId,
          value: await countMailbox(scope, target),
        });
      }),
    );
  }
  // The provider read is outside the transaction. Check the grants and module
  // again before releasing even a cached count to the current member.
  const current = mailboxes.length ? (await authorize()).mailboxes : mailboxes;
  const values = current.map(({ mailboxId, connectionId, available }) => {
    const item = observed.get(mailboxId);
    return [
      mailboxId,
      available && item?.connectionId === connectionId ? item.value : null,
    ] as const;
  });
  return {
    counts: Object.fromEntries(values),
    total: values.reduce((sum, [, count]) => sum + (count ?? 0), 0),
    complete: values.every(([, count]) => count !== null),
  };
}
