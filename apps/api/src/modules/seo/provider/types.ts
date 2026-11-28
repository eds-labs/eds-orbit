import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";

export const seoDimensions = [
  "date",
  "page",
  "query",
  "country",
  "device",
] as const;
export type SeoDimension = (typeof seoDimensions)[number];

export type SeoProperty = { externalId: string; label: string };
export type SeoPerformanceRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};
export type SeoPerformance = { rows: SeoPerformanceRow[] };
export type SeoPerformanceInput = {
  connectionId: string;
  externalId: string;
  startDate: string;
  endDate: string;
  dimension?: SeoDimension;
  limit?: number;
};
export type SeoProviderStatus = {
  appReady: boolean;
  connections: Array<{ id: string; label: string; unavailable: boolean }>;
};

/**
 * The module resolves provider calls in the project's authorized transaction.
 * The prepared work runs after commit so the project lock is never held
 * while waiting for a provider.
 */
export type SeoProvider = {
  id: string;
  status(tx: DbTx, scope: Scope): Promise<SeoProviderStatus>;
  disconnect(tx: DbTx, scope: Scope, connectionId: string): Promise<void>;
  preparePropertyListing(
    tx: DbTx,
    scope: Scope,
    connectionId: string,
  ): Promise<() => Promise<SeoProperty[]>>;
  preparePerformance(
    tx: DbTx,
    scope: Scope,
    input: SeoPerformanceInput,
  ): Promise<() => Promise<SeoPerformance>>;
};

/** An optional connection flow for providers that authorize through a browser. */
export type SeoOAuthProvider<Attempt> = SeoProvider & {
  beginConnect(
    tx: DbTx,
    scope: Scope,
    accountConnectionId?: string,
  ): Promise<{ authorizeUrl: string }>;
  consumeState(tx: DbTx, scope: Scope, state: string): Promise<Attempt>;
  finishConnect(
    scope: Scope,
    input: { code: string; attempt: Attempt },
  ): Promise<{ connectionId: string }>;
};
