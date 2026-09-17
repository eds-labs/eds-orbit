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
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { create, data, encrypt, update } from "../shared.ts";
import { analyze } from "./workflow.ts";
const transport = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("../../../../packages/connectors/src/matomo.ts", () => ({
  createMatomoClient: () => ({ report: transport.report }),
}));
import {
  importMatomoReport,
  normalizeMatomoReport,
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
