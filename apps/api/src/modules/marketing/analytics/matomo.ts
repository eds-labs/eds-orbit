import { connectionAccess } from "../../../platform/connections/connections.ts";
import { lockMetrics } from "./metric-report.ts";
import { z } from "zod";
import {
  authorize,
  PROJECT_OWN,
} from "../../../platform/tenancy/permissions.ts";
import { scoped, type DbTx } from "../../../../../../packages/db/src/index.ts";
import {
  createMatomoClient,
  matomoGoogleSearchReport,
  matomoImportMethods,
  type MatomoReportInput,
} from "../../../../../../packages/connectors/src/matomo.ts";
import { ConnectorError } from "../../../../../../packages/connectors/src/http.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import {
  create,
  entity,
  list,
  data,
  hash,
  audit,
  DomainError,
} from "../../../shared.ts";
import { correctMetric } from "./lifecycle.ts";
import { connectionVerified } from "../../../platform/connections/connections.ts";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
const timezone = z
  .string()
  .min(1)
  .max(80)
  .refine((v) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  });
export const matomoImportInput = z
  .object({
    connectorId: z.uuid(),
    siteId: z.number().int().positive(),
    date: isoDate,
    siteTimezone: timezone,
    currency: z.string().regex(/^[A-Z]{3}$/),
    method: z.enum(matomoImportMethods),
    goalId: z.number().int().positive().optional(),
  })
  .strict()
  .refine((i) => i.goalId === undefined || i.method === "Goals.get", {
    message: "Goal ID is only valid for a Goals report",
  });
export type MatomoImportInput = z.infer<typeof matomoImportInput>;
export type MatomoSnapshot = Awaited<
  ReturnType<ReturnType<typeof createMatomoClient>["report"]>
>;
/** Resolve a site's actual local midnight; a DST day can contain 23 or 25 hours. */
export function matomoDayInterval(date: string, zone: string) {
  isoDate.parse(date);
  timezone.parse(zone);
  const midnight = (day: string) => {
    const wanted = Date.parse(day + "T00:00:00Z");
    let guess = wanted;
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 6; i++) {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
      );
      const local = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      const delta = wanted - local;
      if (delta === 0) return new Date(guess).toISOString();
      guess += delta;
    }
    throw new DomainError("AMBIGUOUS_SITE_DATE");
  };
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
  return { periodStart: midnight(date), periodEnd: midnight(next) };
}
function count(v: unknown) {
  if (v === undefined || v === null || v === "") return null;
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+$/.test(v)
        ? Number(v)
        : NaN;
  if (!Number.isSafeInteger(n) || n < 0)
    throw new DomainError("INVALID_MATOMO_METRIC");
  return n;
}
function searchCounts(rows: unknown[]) {
  const records = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new DomainError("INVALID_MATOMO_REPORT");
    return row as Record<string, unknown>;
  });
  const sum = (field: string) => {
    const counts = records.map((row) => count(row[field]));
    if (!counts.length || counts.some((value) => value === null)) return null;
    return count(
      counts.reduce<number>((total, value) => total + (value ?? 0), 0),
    );
  };
  return { nb_impressions: sum("nb_impressions"), nb_clicks: sum("nb_clicks") };
}
function moneyMicros(v: unknown) {
  if (v === undefined || v === null || v === "") return null;
  const raw = String(v);
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw))
    throw new DomainError("INVALID_MATOMO_REVENUE");
  const [whole, fraction = ""] = raw.split(".");
  const value =
    BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0") || 0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new DomainError("INVALID_MATOMO_REVENUE");
  return Number(value);
}
function displayLabel(raw: string, method: string) {
  if (raw.length > 2000 || /[\u0000-\u001f]/.test(raw))
    throw new DomainError("INVALID_MATOMO_LABEL");
  if (method === "Actions.getPageUrls") {
    try {
      const u = new URL(raw);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        throw new Error();
      u.search = "";
      u.hash = "";
      return u.toString().slice(0, 500);
    } catch {
      return raw.split(/[?#]/)[0]!.slice(0, 500);
    }
  }
  if (raw.length > 200) throw new DomainError("INVALID_MATOMO_LABEL");
  return raw;
}
export function normalizeMatomoReport(
  rawInput: MatomoImportInput,
  snapshot: MatomoSnapshot,
  goalsConfigured: boolean | null = null,
) {
  const input = matomoImportInput.parse(rawInput),
    interval = matomoDayInterval(input.date, input.siteTimezone);
  if (
    snapshot.source !== "matomo" ||
    snapshot.siteId !== input.siteId ||
    snapshot.method !== input.method ||
    snapshot.period !== "day" ||
    snapshot.date !== input.date ||
    snapshot.siteTimezone !== input.siteTimezone
  )
    throw new DomainError("MATOMO_PROVENANCE_MISMATCH");
  const search = input.method === matomoGoogleSearchReport;
  const table = ["Referrers.getCampaigns", "Actions.getPageUrls"].includes(
    input.method,
  );
  if (
    table || search
      ? !Array.isArray(snapshot.data)
      : !snapshot.data ||
        typeof snapshot.data !== "object" ||
        Array.isArray(snapshot.data)
  )
    throw new DomainError("INVALID_MATOMO_REPORT");
  const reportRows = Array.isArray(snapshot.data)
    ? snapshot.data
    : [snapshot.data];
  if (reportRows.length > 1000) throw new DomainError("MATOMO_REPORT_LIMIT");
  const rows =
    search && reportRows.length ? [searchCounts(reportRows)] : reportRows;
  const seen = new Set<string>();
  return rows.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DomainError("INVALID_MATOMO_REPORT");
    const row = value as Record<string, unknown>,
      rawLabel = table
        ? row.label
        : input.method === "Goals.get"
          ? "goal:" + (input.goalId ?? "all")
          : "site:all";
    if (typeof rawLabel !== "string" || !rawLabel)
      throw new DomainError("INVALID_MATOMO_LABEL");
    const identity = hash(rawLabel),
      campaign = displayLabel(rawLabel, input.method);
    // Reports with different denominators must never be silently summed by the insight service.
    const accountId =
      `${input.connectorId}:site:${input.siteId}:report:${input.method}:goal:${input.goalId ?? "all"}` +
      (input.method === "Actions.getPageUrls" ? ":page:" + identity : "");
    const externalId = hash([
      accountId,
      input.date,
      input.siteTimezone,
      input.currency,
      identity,
    ]);
    if (seen.has(externalId)) throw new DomainError("DUPLICATE_MATOMO_ROW");
    seen.add(externalId);
    const sessions = count(row.nb_visits),
      impressions = search ? count(row.nb_impressions) : null,
      sampleSize = search ? impressions : sessions,
      conversions =
        goalsConfigured === false ? null : count(row.nb_conversions);
    const metric = {
      source: "matomo",
      externalId,
      connectorId: input.connectorId,
      siteId: input.siteId,
      accountId,
      reportMethod: input.method,
      reportFamily: input.method,
      date: input.date,
      campaign,
      ...interval,
      timezone: input.siteTimezone,
      currency: input.currency,
      currencyProvenance: "operator_supplied",
      timezoneProvenance: "operator_supplied",
      impressions,
      clicks: search ? count(row.nb_clicks) : null,
      ...(input.method === "Actions.get"
        ? { outlinkClicks: count(row.nb_outlinks) }
        : {}),
      sessions,
      conversions,
      costMicros: null,
      revenueMicros:
        goalsConfigured === false && input.method === "Goals.get"
          ? null
          : moneyMicros(row.revenue),
      convertedSessions: count(row.nb_visits_converted),
      pageviews: count(
        input.method === "Actions.getPageUrls" ? row.nb_hits : row.nb_pageviews,
      ),
      uniqueVisitors: count(row.nb_uniq_visitors),
      sampleSize: sampleSize ?? 0,
      sampleSizeMissing: sampleSize === null,
      goalsConfigured,
      synthetic: false,
      complete: snapshot.complete,
      recordLimit: snapshot.limit,
      limitations: [
        ...(!snapshot.complete
          ? ["Bounded provider report; completeness is not established."]
          : []),
        ...(search
          ? [
              "Google Web Search counts cover only the keyword rows Matomo returned.",
            ]
          : []),
        ...(goalsConfigured === false
          ? ["No configured goal; conversions are unavailable."]
          : goalsConfigured === null
            ? ["Goal configuration was not independently confirmed."]
            : []),
      ],
    };
    return {
      ...metric,
      contentHash: hash(metric),
      providerFetchedAt: snapshot.fetchedAt,
    };
  });
}
export async function importMatomoSnapshot(
  tx: DbTx,
  scope: Scope,
  input: MatomoImportInput,
  snapshot: MatomoSnapshot,
  goalsConfigured: boolean | null = null,
) {
  await lockMetrics(tx, scope);
  const normalized = normalizeMatomoReport(input, snapshot, goalsConfigured),
    existing = await list(tx, scope, "metrics");
  let created = 0,
    unchanged = 0,
    corrected = 0;
  const metricIds: string[] = [];
  for (const row of normalized) {
    const prior = existing.find(
      (m) =>
        data(m).source === "matomo" && data(m).externalId === row.externalId,
    );
    if (prior) {
      metricIds.push(prior.id);
      if (data(prior).contentHash === row.contentHash) {
        unchanged++;
        continue;
      }
      await correctMetric(
        tx,
        scope,
        prior.id,
        prior.version,
        row,
        "MATOMO_REPORT_CORRECTION",
      );
      corrected++;
    } else {
      const metric = await create(tx, scope, "metrics", row);
      metricIds.push(metric.id);
      created++;
    }
  }
  await audit(tx, scope, "matomo.report_imported", input.connectorId, {
    siteId: input.siteId,
    method: input.method,
    date: input.date,
    created,
    unchanged,
    corrected,
    complete: snapshot.complete,
  });
  return {
    created,
    unchanged,
    corrected,
    metricIds,
    complete: snapshot.complete,
    source: "matomo" as const,
  };
}
export async function importMatomoReport(
  scope: Scope,
  rawInput: MatomoImportInput,
) {
  authorize(scope, PROJECT_OWN, "OWNER_REQUIRED");
  const input = matomoImportInput.parse(rawInput);
  const { connector, access } = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const row = await entity(tx, scope, "connectors", input.connectorId);
      // The project's own key, or a granted central connection's (ADR 0014).
      return {
        connector: row,
        access: await connectionAccess(tx, scope, data(row)).catch(() => null),
      };
    },
  );
  const c = data(connector);
  if (
    c.provider !== "matomo" ||
    !connectionVerified(c.status) ||
    Number(c.siteId) !== input.siteId
  )
    throw new DomainError("MATOMO_CONNECTOR_SCOPE", 403);
  if (!access) throw new DomainError("CREDENTIAL_CONFIGURATION_REQUIRED");
  const client = createMatomoClient({
    baseUrl: access.baseUrl ?? c.baseUrl,
    token: access.credential,
    allowedSiteIds: [input.siteId],
  });
  const request: MatomoReportInput = {
    siteId: input.siteId,
    method: input.method,
    period: "day",
    date: input.date,
    siteTimezone: input.siteTimezone,
    ...(input.goalId ? { goalId: input.goalId } : {}),
  };
  const readReport = (report: MatomoReportInput) =>
    client.report(report).catch((error: unknown) => {
      if (!(error instanceof ConnectorError)) throw error;
      throw new DomainError(
        report.method === matomoGoogleSearchReport &&
          error.code === "REPORT_UNAVAILABLE"
          ? "MATOMO_SEARCH_REPORT_UNAVAILABLE"
          : "MATOMO_REPORT_UNAVAILABLE",
        502,
      );
    });
  const snapshot = await readReport(request);
  let goalsConfigured: boolean | null = null;
  if (input.method === "Goals.get") {
    const goals = await readReport({
      ...request,
      method: "Goals.getGoals",
      goalId: undefined,
    });
    const records = Array.isArray(goals.data)
      ? goals.data
      : Object.values(goals.data as object);
    if (records.some((g) => !g || typeof g !== "object" || Array.isArray(g)))
      throw new DomainError("INVALID_MATOMO_GOALS");
    goalsConfigured = records.length > 0;
    if (
      input.goalId &&
      records.length &&
      !records.some(
        (g) => Number((g as Record<string, unknown>).idgoal) === input.goalId,
      )
    )
      throw new DomainError("MATOMO_GOAL_NOT_CONFIGURED");
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await entity(tx, scope, "connectors", connector.id);
    if (
      current.version !== connector.version ||
      data(current).status !== c.status
    )
      throw new DomainError("CONNECTOR_CHANGED");
    return importMatomoSnapshot(tx, scope, input, snapshot, goalsConfigured);
  });
}

/** Keep high-volume campaign and page detail out of the website-wide trend. */
export async function readMatomoTrend(tx: DbTx, scope: Scope) {
  const rowLimit = 500;
  const rows = await tx.entity.findMany({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: "metrics",
      AND: [
        { data: { path: ["source"], equals: "matomo" } },
        { data: { path: ["synthetic"], equals: false } },
        {
          OR: [
            "VisitsSummary.get",
            "Actions.get",
            matomoGoogleSearchReport,
          ].map((method) => ({
            data: { path: ["reportMethod"], equals: method },
          })),
        },
      ],
    },
    select: { data: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: rowLimit + 1,
  });
  return {
    items: rows.slice(0, rowLimit).map((row) => {
      const {
        accountId,
        siteId,
        date,
        timezone,
        currency,
        reportMethod,
        sessions,
        pageviews,
        outlinkClicks,
        impressions,
        clicks,
      } = data(row);
      return {
        accountId,
        siteId,
        date,
        timezone,
        currency,
        reportMethod,
        sessions,
        pageviews,
        outlinkClicks,
        impressions,
        clicks,
      };
    }),
    truncated: rows.length > rowLimit,
  };
}
