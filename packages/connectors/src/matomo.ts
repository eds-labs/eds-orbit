import { z } from "zod";
import { ConnectorError, jsonTransport, type HttpOptions } from "./http.ts";
export const matomoMethods = [
  "VisitsSummary.get",
  "Actions.getPageUrls",
  "Referrers.getCampaigns",
  "Goals.get",
  "Goals.getGoals",
] as const;
export type MatomoReportInput = {
  siteId: number;
  method: (typeof matomoMethods)[number];
  period: "day" | "week" | "month" | "year" | "range";
  date: string;
  siteTimezone: string;
  goalId?: number;
};
export function createMatomoClient(
  options: HttpOptions & { allowedSiteIds: number[] },
) {
  const call = jsonTransport(options);
  return {
    capabilities: { reports: matomoMethods, writes: false, wordpress: false },
    async report(input: MatomoReportInput) {
      if (
        !Number.isSafeInteger(input.siteId) ||
        input.siteId <= 0 ||
        !options.allowedSiteIds.includes(input.siteId)
      )
        throw new ConnectorError("SITE_NOT_ALLOWED");
      if (
        !matomoMethods.includes(input.method) ||
        !["day", "week", "month", "year", "range"].includes(input.period)
      )
        throw new ConnectorError("REPORT_NOT_ALLOWED");
      const dates = input.date.split(",");
      if (
        dates.length !== (input.period === "range" ? 2 : 1) ||
        dates.some(
          (x) =>
            !/^\d{4}-\d{2}-\d{2}$/.test(x) ||
            Number.isNaN(Date.parse(x)) ||
            new Date(x).toISOString().slice(0, 10) !== x,
        ) ||
        (dates[1] && dates[1] < dates[0]!)
      )
        throw new ConnectorError("INVALID_DATE_RANGE");
      try {
        new Intl.DateTimeFormat("en", { timeZone: input.siteTimezone });
      } catch {
        throw new ConnectorError("INVALID_TIMEZONE");
      }
      if (
        input.goalId !== undefined &&
        (!Number.isSafeInteger(input.goalId) ||
          input.goalId <= 0 ||
          input.method !== "Goals.get")
      )
        throw new ConnectorError("INVALID_GOAL");
      const body = new URLSearchParams({
        module: "API",
        method: input.method,
        idSite: String(input.siteId),
        period: input.period,
        date: input.date,
        format: "JSON",
        token_auth: options.token,
        filter_limit: "1000",
        format_metrics: "0",
      });
      if (input.goalId !== undefined) body.set("idGoal", String(input.goalId));
      if (input.method === "Actions.getPageUrls") body.set("flat", "1");
      const result = await call("index.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (
        result &&
        typeof result === "object" &&
        "result" in result &&
        result.result === "error"
      )
        throw new ConnectorError("REPORT_UNAVAILABLE", "rejected");
      if (
        !Array.isArray(result) &&
        !z.record(z.string(), z.unknown()).safeParse(result).success
      )
        throw new ConnectorError("INVALID_PROVIDER_RESPONSE", "rejected");
      return {
        source: "matomo" as const,
        siteId: input.siteId,
        method: input.method,
        period: input.period,
        date: input.date,
        siteTimezone: input.siteTimezone,
        fetchedAt: new Date().toISOString(),
        data: result,
        complete: false,
        limit: 1000,
        goalsConfigured:
          input.method === "Goals.getGoals" && Array.isArray(result)
            ? result.length > 0
            : null,
      };
    },
  };
}
