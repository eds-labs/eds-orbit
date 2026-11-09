import type { AdsProvider } from "../types.ts";
import { classifyMetaFailure } from "./errors.ts";
import { parseMetaUsage } from "./usage.ts";
import { META_ADS_API_VERSION } from "./version.ts";

export const metaAdsProvider: AdsProvider = {
  id: "meta",
  manifest: { apiVersion: META_ADS_API_VERSION, currencyUnit: "minor", validateOnly: true },
  errors: { classify: classifyMetaFailure },
  usage: { parse: parseMetaUsage },
};
