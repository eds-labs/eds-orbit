import type { SocialPlatform } from "../accounts/store.ts";

// What a member sees of a publication (ADR 0020, S5): status, reason, link;
// never provider state beyond the test marker, never tokens.

export type PublicationView = {
  id: string;
  accountId: string;
  platform: SocialPlatform;
  status: string;
  blockedCode: string | null;
  lastErrorCode: string | null;
  externalPostId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  resolution: string | null;
  test: boolean;
  version: number;
};

type Row = {
  id: string;
  accountId: string;
  status: string;
  blockedCode: string | null;
  lastErrorCode: string | null;
  externalPostId: string | null;
  permalink: string | null;
  publishedAt: Date | null;
  resolution: string | null;
  providerState: unknown;
  version: number;
};

export const publicationView = (row: Row, platform: SocialPlatform): PublicationView => ({
  id: row.id,
  accountId: row.accountId,
  platform,
  status: row.status,
  blockedCode: row.blockedCode,
  lastErrorCode: row.lastErrorCode,
  externalPostId: row.externalPostId,
  permalink: row.permalink,
  publishedAt: row.publishedAt?.toISOString() ?? null,
  resolution: row.resolution,
  test: (row.providerState as { test?: unknown } | null)?.test === true,
  version: row.version,
});
