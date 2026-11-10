// The ads module's client side (ADR 0025): types of the /ads API.

export type AdsSettings = {
  decider: "owner";
  autoPauseAtLimit: boolean;
  utmTemplate: string | null;
  reportDay: "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  backfillDays: number;
  insightsRetentionMonths: number;
};

/** GET /projects/:projectId/ads/status */
export type AdsStatus = {
  module: "ads";
  version: string;
  settings: AdsSettings;
  settingsVersion: number;
};

export const adsPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/ads${rest}`;
