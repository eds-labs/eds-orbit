import { collectionPath } from "@/lib/api";

export const seoPath = (projectId: string, suffix = "") =>
  collectionPath(projectId, `seo${suffix}`);
export const websitePath = (id: string) =>
  `/websites/${encodeURIComponent(id)}`;
export const providerPath = (id: string) =>
  `/providers/${encodeURIComponent(id)}`;
export const connectionPath = (providerId: string, connectionId: string) =>
  `${providerPath(providerId)}/connections/${encodeURIComponent(connectionId)}`;
export const propertyPath = (websiteId: string, providerId: string) =>
  `${websitePath(websiteId)}/properties/${encodeURIComponent(providerId)}`;

export type SeoConnection = {
  id: string;
  label: string;
  unavailable: boolean;
};
export type SeoProvider = {
  id: string;
  label: string;
  appReady: boolean;
  canConnect: boolean;
  connections: SeoConnection[];
};
export type SeoProperty = {
  provider: string;
  connectionId: string;
  propertyId: string;
};
export type SeoWebsite = {
  id: string;
  name: string;
  url: string;
  properties: SeoProperty[];
};
export type SeoOverview = {
  canManage: boolean;
  providers: SeoProvider[];
  websites: SeoWebsite[];
};
export const dimensions = [
  "date",
  "page",
  "query",
  "country",
  "device",
] as const;
export type Dimension = (typeof dimensions)[number];
export type SeoPerformance = {
  provider: string;
  websiteId: string;
  startDate: string;
  endDate: string;
  dimension: Dimension;
  rows: {
    keys: string[];
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
};
export type ProviderProperty = { id: string; label: string };
export const maxReportDays = 90;
export const maxReportRows = 100;
const dayMs = 86_400_000;

export function initialRange(now = Date.now()) {
  const end = now - 3 * dayMs;
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { startDate: date(end - 27 * dayMs), endDate: date(end) };
}

export function validRange(startDate: string, endDate: string) {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end >= start &&
    end - start < maxReportDays * dayMs
  );
}
