import { describe, expect, it } from "vitest";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { classifyMetaFailure } from "../src/modules/ads/providers/meta/errors.ts";
import { parseMetaUsage } from "../src/modules/ads/providers/meta/usage.ts";
import { AdsProviderError } from "../src/modules/ads/providers/types.ts";
import type { FailureInput } from "../src/modules/ads/providers/types.ts";

const graph = (error: Record<string, unknown>) => ({ error });
const usageHeaders = (name: string, value: unknown) => new Headers({ [name]: typeof value === "string" ? value : JSON.stringify(value) });

type Row = { name: string; input: FailureInput; expect: Record<string, unknown> };
const rows: Row[] = [
  { name: "1 transport not_sent write", input: { write: true, transport: new ConnectorError("DNS_FAILED", "not_sent", true) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: "not_sent", retryable: true } },
  { name: "1 transport unknown write", input: { write: true, transport: new ConnectorError("NETWORK_ERROR", "unknown") }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false } },
  { name: "1 transport not_sent read", input: { write: false, transport: new ConnectorError("DNS_FAILED", "not_sent", true) }, expect: { outcome: "not_sent", retryable: true } },
  { name: "1 transport unknown read", input: { write: false, transport: new ConnectorError("NETWORK_ERROR", "unknown") }, expect: { outcome: "unknown", retryable: false } },
  { name: "2 code 190", input: { write: true, httpStatus: 400, body: graph({ code: 190 }) }, expect: { kind: "auth", code: "ADS_META_TOKEN_INVALID", outcome: "rejected", retryable: false, providerCode: 190 } },
  { name: "2 code 102", input: { write: false, httpStatus: 400, body: graph({ code: 102 }) }, expect: { code: "ADS_META_TOKEN_INVALID" } },
  { name: "2 http 401 no code", input: { write: false, httpStatus: 401, body: {} }, expect: { kind: "auth", code: "ADS_META_TOKEN_INVALID", retryable: false } },
  { name: "3 code 10", input: { write: true, httpStatus: 403, body: graph({ code: 10 }) }, expect: { kind: "permission", code: "ADS_META_PERMISSION_MISSING", outcome: "rejected", retryable: false } },
  { name: "3 code 200", input: { write: true, httpStatus: 403, body: graph({ code: 200 }) }, expect: { code: "ADS_META_PERMISSION_MISSING" } },
  { name: "3 code 299", input: { write: true, httpStatus: 403, body: graph({ code: 299 }) }, expect: { code: "ADS_META_PERMISSION_MISSING" } },
  { name: "4 concurrent edit", input: { write: true, httpStatus: 400, body: graph({ code: 613, error_subcode: 4841018 }) }, expect: { kind: "rate_limited", code: "ADS_META_CONCURRENT_EDIT", outcome: "rejected", retryable: true, retryAfterMs: 30_000, providerSubcode: 4841018 } },
  { name: "5 temporarily blocked", input: { write: true, httpStatus: 400, body: graph({ code: 368 }) }, expect: { kind: "rate_limited", code: "ADS_META_TEMPORARILY_BLOCKED", retryable: true, retryAfterMs: 3_600_000 } },
  ...[4, 17, 32, 341, 613, 80000, 80014].map((code): Row => ({ name: `6 code ${code}`, input: { write: true, httpStatus: 400, body: graph({ code }) }, expect: { kind: "rate_limited", code: "ADS_META_RATE_LIMITED", outcome: "rejected", retryable: true, retryAfterMs: 60_000 } })),
  { name: "6 http 429", input: { write: false, httpStatus: 429, body: {} }, expect: { code: "ADS_META_RATE_LIMITED", retryAfterMs: 60_000 } },
  { name: "6 regain from usage header", input: { write: false, httpStatus: 400, body: graph({ code: 17 }), headers: usageHeaders("x-business-use-case-usage", { "123": [{ type: "ads_management", call_count: 10, total_cputime: 5, total_time: 5, estimated_time_to_regain_access: 7 }] }) }, expect: { code: "ADS_META_RATE_LIMITED", retryAfterMs: 420_000 } },
  { name: "7 code 100 with blame", input: { write: true, httpStatus: 400, body: graph({ code: 100, error_user_title: "Bad budget", error_user_msg: "Budget too low", fbtrace_id: "ABC", error_data: { blame_field_specs: [["adset", "daily_budget"], ["name"]] } }) }, expect: { kind: "validation", code: "ADS_PROVIDER_VALIDATION", outcome: "rejected", retryable: false, fieldPaths: ["adset.daily_budget", "name"], userTitle: "Bad budget", userMessage: "Budget too low", traceId: "ABC" } },
  { name: "7 blame without code", input: { write: true, httpStatus: 400, body: graph({ code: 1487, error_data: { blame_field_specs: [["x"]] } }) }, expect: { code: "ADS_PROVIDER_VALIDATION", fieldPaths: ["x"] } },
  { name: "7 code 100 no blame", input: { write: true, httpStatus: 400, body: graph({ code: 100 }) }, expect: { code: "ADS_PROVIDER_VALIDATION", fieldPaths: [] } },
  { name: "8 code 1 write", input: { write: true, httpStatus: 500, body: graph({ code: 1 }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false } },
  { name: "8 code 2 read", input: { write: false, httpStatus: 500, body: graph({ code: 2 }) }, expect: { outcome: "rejected", retryable: true, retryAfterMs: 5_000 } },
  { name: "8 is_transient write", input: { write: true, httpStatus: 400, body: graph({ code: 9999, is_transient: true }) }, expect: { code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false } },
  { name: "8 is_transient read", input: { write: false, httpStatus: 400, body: graph({ code: 9999, is_transient: true }) }, expect: { outcome: "rejected", retryable: true, retryAfterMs: 5_000 } },
  { name: "8 http 503 write", input: { write: true, httpStatus: 503, body: graph({ code: 9999 }) }, expect: { code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false } },
  { name: "8 http 502 read", input: { write: false, httpStatus: 502 }, expect: { code: "ADS_PROVIDER_UNAVAILABLE", outcome: "rejected", retryable: true, retryAfterMs: 5_000 } },
  { name: "3 subcode 1713092 (code 2654)", input: { write: true, httpStatus: 400, body: graph({ code: 2654, error_subcode: 1713092 }) }, expect: { kind: "permission", code: "ADS_META_PERMISSION_MISSING", outcome: "rejected", retryable: false } },
  { name: "3 code 2708008", input: { write: true, httpStatus: 400, body: graph({ code: 2708008 }) }, expect: { kind: "permission", code: "ADS_META_PERMISSION_MISSING" } },
  { name: "3 code 1815694", input: { write: true, httpStatus: 400, body: graph({ code: 1815694 }) }, expect: { code: "ADS_META_PERMISSION_MISSING" } },
  { name: "5 subcode 1404078", input: { write: true, httpStatus: 400, body: graph({ code: 368, error_subcode: 1404078 }) }, expect: { kind: "rate_limited", code: "ADS_META_TEMPORARILY_BLOCKED", retryable: true, retryAfterMs: 3_600_000 } },
  { name: "5 subcode 1404078 other code", input: { write: true, httpStatus: 400, body: graph({ code: 1, error_subcode: 1404078 }) }, expect: { code: "ADS_META_TEMPORARILY_BLOCKED", retryAfterMs: 3_600_000 } },
  { name: "5 code 2859015", input: { write: true, httpStatus: 400, body: graph({ code: 2859015 }) }, expect: { code: "ADS_META_TEMPORARILY_BLOCKED", retryable: true, retryAfterMs: 3_600_000 } },
  ...[true, false].flatMap((write): Row[] => [
    { name: `8 code 5000 write=${write}`, input: { write, httpStatus: 400, body: graph({ code: 5000 }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", ...(write ? { outcome: "unknown", retryable: false } : { outcome: "rejected", retryable: true, retryAfterMs: 5_000 }) } },
    { name: `8 code -1 write=${write}`, input: { write, httpStatus: 400, body: graph({ code: -1 }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", ...(write ? { outcome: "unknown", retryable: false } : { outcome: "rejected", retryable: true, retryAfterMs: 5_000 }) } },
    { name: `8 subcode 3910001 write=${write}`, input: { write, httpStatus: 400, body: graph({ code: 9999, error_subcode: 3910001 }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", ...(write ? { outcome: "unknown", retryable: false } : { outcome: "rejected", retryable: true, retryAfterMs: 5_000 }) } },
  ]),
  { name: "9 other 4xx", input: { write: true, httpStatus: 404, body: graph({ code: 803 }) }, expect: { kind: "validation", code: "ADS_PROVIDER_REJECTED", outcome: "rejected", retryable: false } },
  { name: "10 non-2xx no graph write", input: { write: true, httpStatus: 404, body: "<html>" }, expect: { kind: "unknown", code: "ADS_PROVIDER_RESPONSE_INVALID", outcome: "unknown", retryable: false } },
  { name: "10 non-2xx no graph read", input: { write: false, httpStatus: 404, body: {} }, expect: { code: "ADS_PROVIDER_RESPONSE_INVALID", outcome: "rejected", retryable: true, retryAfterMs: 5_000 } },
  { name: "10 2xx invalid schema write", input: { write: true, httpStatus: 200, body: { nope: 1 } }, expect: { code: "ADS_PROVIDER_RESPONSE_INVALID", outcome: "unknown", retryable: false } },
  { name: "10 2xx invalid schema read", input: { write: false, httpStatus: 200 }, expect: { code: "ADS_PROVIDER_RESPONSE_INVALID", outcome: "rejected", retryable: true, retryAfterMs: 5_000 } },
  { name: "1b write 503 + code 4 is unknown", input: { write: true, httpStatus: 503, body: graph({ code: 4 }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false, providerCode: 4, httpStatus: 503 } },
  { name: "1b write 500 + code 100 is unknown", input: { write: true, httpStatus: 500, body: graph({ code: 100, fbtrace_id: "T9" }) }, expect: { kind: "transient", code: "ADS_PROVIDER_UNAVAILABLE", outcome: "unknown", retryable: false, providerCode: 100, traceId: "T9" } },
  { name: "1b read 503 + code 4 stays rate_limited", input: { write: false, httpStatus: 503, body: graph({ code: 4 }) }, expect: { kind: "rate_limited", code: "ADS_META_RATE_LIMITED", outcome: "rejected", retryable: true } },
  { name: "1 read RESPONSE_TOO_LARGE not retryable", input: { write: false, transport: new ConnectorError("RESPONSE_TOO_LARGE", "not_sent") }, expect: { outcome: "not_sent", retryable: false } },
  { name: "1 read REQUEST_TOO_LARGE not retryable", input: { write: false, transport: new ConnectorError("REQUEST_TOO_LARGE", "not_sent") }, expect: { outcome: "not_sent", retryable: false } },
  { name: "1 read NETWORK_ERROR not_sent retryable", input: { write: false, transport: new ConnectorError("NETWORK_ERROR", "not_sent") }, expect: { outcome: "not_sent", retryable: true } },
];

describe("classifyMetaFailure", () => {
  it.each(rows)("$name", ({ input, expect: want }) => {
    expect(classifyMetaFailure(input)).toMatchObject(want);
  });

  it("carries http status, code, subcode and trace id", () => {
    const f = classifyMetaFailure({ write: true, httpStatus: 400, body: graph({ code: 613, error_subcode: 4841018, fbtrace_id: "T1" }) });
    expect(f).toMatchObject({ httpStatus: 400, providerCode: 613, providerSubcode: 4841018, traceId: "T1", fieldPaths: [] });
  });

  it("redacts token words and truncates user messages to 300 chars", () => {
    const f = classifyMetaFailure({ write: true, httpStatus: 400, body: graph({ code: 100, error_user_msg: "failed access_token=EAABsecret123 here" }) });
    expect(f.userMessage).not.toContain("EAAB");
    expect(f.userMessage).toContain("[redacted]");
    const long = classifyMetaFailure({ write: true, httpStatus: 400, body: graph({ code: 100, error_user_msg: "a".repeat(1000), error_user_title: "t".repeat(1000) }) });
    expect(long.userMessage).toHaveLength(300);
    expect(long.userTitle).toHaveLength(300);
  });

  it.each(["Bearer EAABxxxxxxxxxxxxxxxxxxxxxxxxxxxx failed", "call failed for EAABxxxxxxxxxxxxxxxxxxxxxxxxxxxx today"])("never leaks a token shape: %s", message => {
    const f = classifyMetaFailure({ write: true, httpStatus: 400, body: graph({ code: 100, error_user_msg: message, error_user_title: message }) });
    expect(JSON.stringify(f)).not.toContain("EAAB");
    expect(f.userMessage).toContain("[redacted]");
  });

  it("AdsProviderError message is the failure code only", () => {
    const failure = classifyMetaFailure({ write: true, httpStatus: 400, body: graph({ code: 100, error_user_msg: "secret text" }) });
    const error = new AdsProviderError(failure);
    expect(error.message).toBe("ADS_PROVIDER_VALIDATION");
    expect(error.failure).toBe(failure);
  });
});

describe("parseMetaUsage", () => {
  it("maps x-business-use-case-usage", () => {
    const hint = parseMetaUsage(usageHeaders("x-business-use-case-usage", { "1": [{ type: "ads_insights", call_count: 20, total_cputime: 40, total_time: 30, estimated_time_to_regain_access: 3, ads_api_access_tier: "development_access" }] }));
    expect(hint).toEqual({ buckets: [{ bucket: "meta_ads_insights", usagePct: 40, regainMs: 180_000 }], accessTier: "limited" });
  });
  it("omits regainMs when 0", () => {
    const hint = parseMetaUsage(usageHeaders("x-business-use-case-usage", { "1": [{ type: "ads_management", call_count: 1, total_cputime: 2, total_time: 3, estimated_time_to_regain_access: 0, ads_api_access_tier: "standard_access" }] }));
    expect(hint.buckets).toEqual([{ bucket: "meta_ads_management", usagePct: 3 }]);
    expect(hint.accessTier).toBe("full");
  });
  it("maps tier prefixes and ignores unknown tiers", () => {
    const tier = (v: string) => parseMetaUsage(usageHeaders("x-business-use-case-usage", { "1": [{ type: "t", call_count: 0, total_cputime: 0, total_time: 0, ads_api_access_tier: v }] })).accessTier;
    expect(tier("limited_access")).toBe("limited");
    expect(tier("full_access")).toBe("full");
    expect(tier("weird")).toBeUndefined();
  });
  it("maps x-ad-account-usage", () => {
    expect(parseMetaUsage(usageHeaders("x-ad-account-usage", { acc_id_util_pct: 55, reset_time_duration: 120 })).buckets).toEqual([{ bucket: "meta_ad_account", usagePct: 55, regainMs: 120_000 }]);
  });
  it("maps x-app-usage", () => {
    expect(parseMetaUsage(usageHeaders("x-app-usage", { call_count: 10, total_cputime: 25, total_time: 5 })).buckets).toEqual([{ bucket: "meta_app", usagePct: 25 }]);
  });
  it("maps x-fb-ads-insights-throttle", () => {
    expect(parseMetaUsage(usageHeaders("x-fb-ads-insights-throttle", { app_id_util_pct: 12, acc_id_util_pct: 30 })).buckets).toEqual([{ bucket: "meta_insights_throttle", usagePct: 30 }]);
  });
  it("skips malformed headers without throwing", () => {
    expect(parseMetaUsage(usageHeaders("x-app-usage", "{"))).toEqual({ buckets: [] });
    expect(parseMetaUsage(new Headers())).toEqual({ buckets: [] });
  });
});
