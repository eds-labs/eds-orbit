import { matomoImportDays, matomoSearchImportDays } from "./matomo-schedule.ts";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createClient,
  scoped,
  closeDatabase,
  type PrismaClient,
} from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { create, data, encrypt, update } from "../../../shared.ts";
import { analyze } from "../pipeline/workflow.ts";
const transport = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock(
  import("../../../../../../packages/connectors/src/matomo.ts"),
  async (original) => {
    const actual = await original();
    return {
      ...actual,
      createMatomoClient: (options) => ({
        ...actual.createMatomoClient(options),
        report: transport.report,
      }),
    };
  },
);
import { ConnectorError } from "../../../../../../packages/connectors/src/http.ts";
import { matomoGoogleSearchReport } from "../../../../../../packages/connectors/src/matomo.ts";
import {
  importMatomoReport,
  normalizeMatomoReport,
  readMatomoTrend,
  matomoDayInterval,
  matomoImportInput,
  type MatomoImportInput,
  type MatomoSnapshot,
} from "./matomo.ts";
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const snapshot = (
  input: MatomoImportInput,
  payload: unknown,
): MatomoSnapshot => ({
  source: "matomo",
  siteId: input.siteId,
  method: input.method,
  period: "day",
  date: input.date,
  siteTimezone: input.siteTimezone,
  fetchedAt: new Date().toISOString(),
  data: payload as MatomoSnapshot["data"],
  complete: false,
  limit: 1000,
  goalsConfigured: null,
});
describe("Matomo schedule calendar days", () => {
  it("does not skip yesterday after a short daylight-saving day", () => {
    expect(
      matomoImportDays(new Date("2026-03-29T22:30:00Z"), "Europe/Berlin"),
    ).toEqual(["2026-03-29", "2026-03-30"]);
  });
  it("rechecks seven closed dates for delayed Search Console data across a month boundary", () => {
    expect(matomoSearchImportDays("2026-11-03")).toEqual([
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });
});
describe("Matomo report normalization", () => {
  const input: MatomoImportInput = {
    connectorId: randomUUID(),
    siteId: 17,
    date: "2026-03-29",
    siteTimezone: "Europe/Berlin",
    currency: "EUR",
    method: "VisitsSummary.get",
  };
  it("uses site-local 23/25-hour DST intervals", () => {
    const spring = matomoDayInterval("2026-03-29", "Europe/Berlin"),
      fall = matomoDayInterval("2026-10-25", "Europe/Berlin");
    expect(Date.parse(spring.periodEnd) - Date.parse(spring.periodStart)).toBe(
      23 * 3600000,
    );
    expect(Date.parse(fall.periodEnd) - Date.parse(fall.periodStart)).toBe(
      25 * 3600000,
    );
    expect(spring.periodStart).toBe("2026-03-28T23:00:00.000Z");
  });
  it("preserves missing versus zero and never relabels actions as clicks or revenue as spend", () => {
    const [row] = normalizeMatomoReport(
      input,
      snapshot(input, { nb_visits: 0, nb_actions: 32, revenue: "1.25" }),
    );
    expect(row).toMatchObject({
      sessions: 0,
      conversions: null,
      clicks: null,
      costMicros: null,
      revenueMicros: 1250000,
      sampleSize: 0,
      synthetic: false,
      complete: false,
    });
  });
  it("keeps outbound link actions apart from search clicks and preserves measured zeros", () => {
    const actions = { ...input, method: "Actions.get" as const };
    const [row] = normalizeMatomoReport(
      actions,
      snapshot(actions, { nb_pageviews: "24", nb_outlinks: 0 }),
    );
    expect(row).toMatchObject({
      pageviews: 24,
      outlinkClicks: 0,
      clicks: null,
      impressions: null,
      sessions: null,
    });
  });
  it("aggregates Google Web Search rows without retaining keyword labels", () => {
    const search: MatomoImportInput = {
      ...input,
      method: matomoGoogleSearchReport,
    };
    const [row] = normalizeMatomoReport(
      search,
      snapshot(search, [
        { label: "private search term", nb_impressions: 100, nb_clicks: "6" },
        { label: "second term", nb_impressions: "20", nb_clicks: 0 },
      ]),
    );
    expect(row).toMatchObject({
      impressions: 120,
      clicks: 6,
      sessions: null,
      sampleSize: 120,
      complete: false,
    });
    expect(JSON.stringify(row)).not.toContain("private search term");
    expect(row?.accountId).toContain(matomoGoogleSearchReport);
  });
  it("keeps an absent search metric unknown and an empty provider report empty", () => {
    const search: MatomoImportInput = {
      ...input,
      method: matomoGoogleSearchReport,
    };
    const [row] = normalizeMatomoReport(
      search,
      snapshot(search, [{ nb_impressions: 0, nb_clicks: 0 }, { nb_clicks: 0 }]),
    );
    expect(row).toMatchObject({
      impressions: null,
      clicks: 0,
      sampleSizeMissing: true,
    });
    expect(normalizeMatomoReport(search, snapshot(search, []))).toEqual([]);
    expect(() =>
      normalizeMatomoReport(
        search,
        snapshot(search, [
          { nb_clicks: 0, nb_impressions: Number.MAX_SAFE_INTEGER },
          { nb_impressions: 1 },
        ]),
      ),
    ).toThrow("INVALID_MATOMO_METRIC");
  });
  it("separates report denominators and strips private page URL query values", () => {
    const pages = { ...input, method: "Actions.getPageUrls" as const };
    const rows = normalizeMatomoReport(
      pages,
      snapshot(pages, [
        {
          label: "https://example.invalid/a?token=private",
          nb_visits: 3,
          nb_hits: 4,
        },
        { label: "https://example.invalid/b", nb_visits: 3, nb_hits: 4 },
      ]),
    );
    expect(rows[0]?.campaign).toBe("https://example.invalid/a");
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(rows[0]?.accountId).not.toBe(rows[1]?.accountId);
  });
  it("rejects malformed dates, scope mismatches, duplicate row IDs and invalid metric values", () => {
    expect(
      matomoImportInput.safeParse({ ...input, date: "2026-02-30" }).success,
    ).toBe(false);
    expect(() =>
      normalizeMatomoReport(input, { ...snapshot(input, {}), siteId: 18 }),
    ).toThrow("MATOMO_PROVENANCE_MISMATCH");
    expect(() =>
      normalizeMatomoReport(input, snapshot(input, { nb_visits: "NaN" })),
    ).toThrow("INVALID_MATOMO_METRIC");
    const campaigns = { ...input, method: "Referrers.getCampaigns" as const };
    expect(() =>
      normalizeMatomoReport(
        campaigns,
        snapshot(campaigns, [
          { label: "same", nb_visits: 1 },
          { label: "same", nb_visits: 2 },
        ]),
      ),
    ).toThrow("DUPLICATE_MATOMO_ROW");
  });
});
describe.skipIf(!enabled)(
  "Matomo mocked report / real scoped SQL import",
  () => {
    let auth: PrismaClient,
      scope: Scope,
      input: MatomoImportInput,
      connectorId: string;
    const run = <T>(fn: Parameters<typeof scoped<T>>[2]) =>
      scoped(scope.workspaceId, scope.projectId, fn);
    beforeAll(() => {
      auth = createClient(process.env.TEST_AUTH_DATABASE_URL!);
      vi.stubEnv("CREDENTIAL_KEY", randomBytes(32).toString("hex"));
    });
    beforeEach(async () => {
      transport.report.mockReset();
      const user = await auth.user.create({
        data: {
          id: randomUUID(),
          name: "Synthetic Matomo owner",
          email: randomUUID() + "@example.invalid",
        },
      });
      const workspace = await auth.workspace.create({
        data: {
          name: "Synthetic Matomo imports",
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
      const project = await auth.project.create({
        data: { workspaceId: workspace.id, name: "Isolated report test" },
      });
      scope = {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: user.id,
        role: "owner",
      };
      connectorId = (
        await run((tx) =>
          create(tx, scope, "connectors", {
            name: "Mock Matomo",
            provider: "matomo",
            status: "read_verified",
            siteId: 17,
            baseUrl: "https://analytics.example.invalid",
            encryptedCredential: encrypt(
              randomBytes(24).toString("hex"),
              process.env.CREDENTIAL_KEY!,
            ),
          }),
        )
      ).id;
      input = {
        connectorId,
        siteId: 17,
        date: "2026-09-16",
        siteTimezone: "Europe/Berlin",
        currency: "EUR",
        method: "VisitsSummary.get",
      };
      transport.report.mockImplementation(async () =>
        snapshot(input, { nb_visits: 40, nb_uniq_visitors: 31 }),
      );
    });
    afterAll(async () => {
      await auth?.$disconnect();
      await closeDatabase();
      vi.unstubAllEnvs();
    });
    it("serializes competing repeated imports without duplicate metric identities", async () => {
      const results = await Promise.all([
        importMatomoReport(scope, input),
        importMatomoReport(scope, input),
      ]);
      expect(results.reduce((sum, r) => sum + r.created, 0)).toBe(1);
      expect(results.reduce((sum, r) => sum + r.unchanged, 0)).toBe(1);
      expect(new Set(results.flatMap((r) => r.metricIds)).size).toBe(1);
    });
    it("imports, deduplicates a repeat, preserves correction versions and invalidates old insights", async () => {
      const first = await importMatomoReport(scope, input);
      expect(first).toMatchObject({ created: 1, unchanged: 0, corrected: 0 });
      const repeated = await importMatomoReport(scope, input);
      expect(repeated).toMatchObject({
        created: 0,
        unchanged: 1,
        corrected: 0,
      });
      const insight = await run((tx) => analyze(tx, scope));
      transport.report.mockImplementation(async () =>
        snapshot(input, { nb_visits: 45, nb_uniq_visitors: 34 }),
      );
      expect(await importMatomoReport(scope, input)).toMatchObject({
        created: 0,
        unchanged: 0,
        corrected: 1,
      });
      const metric = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: first.metricIds[0]! } }),
      );
      expect(metric.version).toBe(2);
      expect(data(metric)).toMatchObject({
        sessions: 45,
        currency: "EUR",
        timezone: "Europe/Berlin",
        siteId: 17,
        reportMethod: "VisitsSummary.get",
      });
      expect(
        data(
          await run((tx) =>
            tx.entity.findUniqueOrThrow({ where: { id: insight.id } }),
          ),
        ).status,
      ).toBe("invalidated");
      expect(
        await run((tx) =>
          tx.entityVersion.count({ where: { entityId: metric.id } }),
        ),
      ).toBe(2);
    });
    it("reports an unavailable Google search report without writing metrics or exposing provider details", async () => {
      const search: MatomoImportInput = {
        ...input,
        method: matomoGoogleSearchReport,
      };
      transport.report.mockRejectedValue(
        new ConnectorError(
          "REPORT_UNAVAILABLE",
          "rejected",
          false,
          200,
          "private provider details",
        ),
      );
      await expect(importMatomoReport(scope, search)).rejects.toMatchObject({
        code: "MATOMO_SEARCH_REPORT_UNAVAILABLE",
        status: 502,
      });
      expect(await run((tx) => readMatomoTrend(tx, scope))).toEqual({
        items: [],
        truncated: false,
      });
    });
    it("reads corrected daily search totals for the chart and excludes detailed and synthetic rows", async () => {
      const search: MatomoImportInput = {
        ...input,
        method: matomoGoogleSearchReport,
      };
      await importMatomoReport(scope, input);
      transport.report.mockResolvedValue(
        snapshot(search, [
          { label: "first query", nb_impressions: 14, nb_clicks: 1 },
        ]),
      );
      const first = await importMatomoReport(scope, search);
      expect(first.created).toBe(1);
      transport.report.mockResolvedValue(
        snapshot(search, [
          { label: "second query", nb_impressions: 16, nb_clicks: 2 },
        ]),
      );
      const revised = await importMatomoReport(scope, search);
      expect(revised).toMatchObject({
        corrected: 1,
        metricIds: first.metricIds,
      });
      await run(async (tx) => {
        await create(tx, scope, "metrics", {
          source: "matomo",
          synthetic: false,
          reportMethod: "Actions.getPageUrls",
        });
        await create(tx, scope, "metrics", {
          source: "matomo",
          synthetic: true,
          reportMethod: "Actions.get",
        });
        const chart = await readMatomoTrend(tx, scope);
        expect(chart.truncated).toBe(false);
        expect(chart.items).toHaveLength(2);
        expect(chart.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              reportMethod: input.method,
              sessions: 40,
            }),
            expect.objectContaining({
              reportMethod: search.method,
              impressions: 16,
              clicks: 2,
              sessions: null,
            }),
          ]),
        );
        expect(JSON.stringify(chart)).not.toMatch(/query|providerFetchedAt/);
      });
    });
    it("refuses connector/site/role mismatch before the report read", async () => {
      await expect(
        importMatomoReport({ ...scope, role: "viewer" }, input),
      ).rejects.toThrow("OWNER_REQUIRED");
      await expect(
        importMatomoReport(scope, { ...input, siteId: 18 }),
      ).rejects.toThrow("MATOMO_CONNECTOR_SCOPE");
      expect(transport.report).not.toHaveBeenCalled();
    });
    it("fences a connector permission change during the external read", async () => {
      transport.report.mockImplementation(async () => {
        await run(async (tx) => {
          const c = await tx.entity.findUniqueOrThrow({
            where: { id: connectorId },
          });
          await update(tx, scope, c, { ...data(c), status: "disabled" });
        });
        return snapshot(input, { nb_visits: 40 });
      });
      await expect(importMatomoReport(scope, input)).rejects.toThrow(
        "CONNECTOR_CHANGED",
      );
      expect(
        await run((tx) => tx.entity.count({ where: { kind: "metrics" } })),
      ).toBe(0);
    });
    it("treats no configured goals as unavailable conversions and preserves known zero otherwise", async () => {
      input = { ...input, method: "Goals.get" };
      transport.report.mockImplementation(async (request) =>
        snapshot(
          { ...input, method: request.method },
          request.method === "Goals.getGoals"
            ? []
            : { nb_conversions: 0, revenue: 0 },
        ),
      );
      const result = await importMatomoReport(scope, input);
      const metric = await run((tx) =>
        tx.entity.findUniqueOrThrow({ where: { id: result.metricIds[0]! } }),
      );
      expect(data(metric)).toMatchObject({
        conversions: null,
        revenueMicros: null,
        goalsConfigured: false,
      });
      transport.report.mockImplementation(async (request) =>
        snapshot(
          { ...input, method: request.method },
          request.method === "Goals.getGoals"
            ? [{ idgoal: 1, name: "Synthetic goal" }]
            : { nb_conversions: 0, revenue: 0 },
        ),
      );
      await importMatomoReport(scope, input);
      expect(
        data(
          await run((tx) =>
            tx.entity.findUniqueOrThrow({ where: { id: metric.id } }),
          ),
        ),
      ).toMatchObject({
        conversions: 0,
        revenueMicros: 0,
        goalsConfigured: true,
      });
    });
    it("prevents insights from adding site totals to campaign/page report denominators", async () => {
      await importMatomoReport(scope, input);
      input = { ...input, method: "Referrers.getCampaigns" };
      transport.report.mockImplementation(async () =>
        snapshot(input, [{ label: "Synthetic campaign", nb_visits: 20 }]),
      );
      await importMatomoReport(scope, input);
      await expect(run((tx) => analyze(tx, scope))).rejects.toThrow(
        "METRIC_DIMENSIONS_MUST_MATCH",
      );
      expect(
        data(await run((tx) => analyze(tx, scope, "Synthetic campaign"))),
      ).toMatchObject({ sessions: 20, status: "hypothesis" });
    });
  },
);
