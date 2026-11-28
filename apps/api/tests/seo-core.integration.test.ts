import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import {
  createConnection,
  grantConnection,
} from "../src/platform/administration/connections.ts";
import { createProjectConnection } from "../src/platform/connections/project-secrets.ts";
import {
  defaultEntitlements,
  setEntitlementsResolver,
} from "../src/platform/entitlements/entitlements.ts";
import { buildServer } from "../src/server.ts";
import { createAdsProject, type AdsProject } from "./support/ads-fixtures.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const provider = "google-search-console";
const website = {
  name: "Organic search website",
  url: "https://site.example.invalid",
};
const propertyId = "sc-domain:site.example.invalid";
const report = new URLSearchParams({
  provider,
  startDate: "2026-11-01",
  endDate: "2026-11-10",
  dimension: "query",
  limit: "10",
}).toString();

describe.skipIf(!enabled)("SEO Core routes and persistence", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let primary: AdsProject;
  let foreign: AdsProject;
  let appConnectionId: string;

  const request = (
    fixture: AdsProject,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    payload?: object,
    role: keyof AdsProject["cookies"] = "owner",
  ) =>
    app.inject({
      method,
      url: `/api/projects/${fixture.projectId}${path}`,
      headers: {
        origin: process.env.APP_ORIGIN!,
        cookie: fixture.cookies[role],
      },
      ...(payload ? { payload } : {}),
    });
  const activate = (fixture: AdsProject, active: boolean) =>
    request(fixture, "PUT", "/modules/seo", { enabled: active });
  const createSite = (fixture = primary, input = website) =>
    request(fixture, "POST", "/seo/websites", input);

  beforeAll(async () => {
    vi.stubEnv("ORBIT_SEO", "true");
    vi.stubEnv("ORBIT_MODULES", "true");
    vi.stubEnv("ORBIT_MODULE_ROLES", "true");
    vi.stubEnv("ORBIT_MARKETING", "false");
    vi.stubEnv("ORBIT_CONNECTIONS", "true");
    app = await buildServer();
    primary = await createAdsProject({
      app,
      enabled: false,
      name: "Synthetic SEO project",
    });
    foreign = await createAdsProject({
      app,
      enabled: false,
      name: "Unrelated SEO project",
    });
  });

  afterEach(() => {
    setEntitlementsResolver();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await primary?.cleanup();
    await foreign?.cleanup();
    if (appConnectionId)
      await authDb.connection.deleteMany({ where: { id: appConnectionId } });
    await app?.close();
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("registers SEO without Marketing, requires explicit project opt-in and retains sites on disable", async () => {
    expect((await request(primary, "GET", "/modules")).json().modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "seo", enabled: false, dependsOn: [] }),
      ]),
    );
    expect((await request(primary, "GET", "/seo")).statusCode).toBe(404);
    expect((await activate(primary, true)).statusCode).toBe(200);
    const initial = await request(primary, "GET", "/seo");
    expect(initial.json()).toMatchObject({
      canManage: true,
      providers: [{ id: provider, appReady: false, connections: [] }],
      websites: [],
    });

    const first = await createSite();
    expect(first.statusCode).toBe(201);
    const created = first.json();
    expect(created).toMatchObject({
      ...website,
      url: `${website.url}/`,
      properties: [],
    });
    expect(
      (await createSite(primary, { name: "Duplicate", url: `${website.url}/` }))
        .statusCode,
    ).toBe(409);
    const second = await createSite(primary, {
      name: "Second site",
      url: "https://second.example.invalid/de/",
    });
    expect(second.statusCode).toBe(201);
    expect(
      (
        await createSite(primary, {
          name: "Invalid",
          url: "https://person:test@site.example.invalid/",
        })
      ).statusCode,
    ).toBe(400);
    expect((await activate(primary, false)).statusCode).toBe(200);
    expect((await request(primary, "GET", "/seo")).statusCode).toBe(404);
    vi.stubEnv("ORBIT_MODULES", "false");
    expect((await request(primary, "GET", "/seo")).statusCode).toBe(404);
    vi.stubEnv("ORBIT_MODULES", "true");
    expect((await activate(primary, true)).statusCode).toBe(200);
    expect(
      (await request(primary, "GET", "/seo"))
        .json()
        .websites.map((item: { id: string }) => item.id),
    ).toEqual([created.id, second.json().id]);
    vi.stubEnv("ORBIT_SEO", "false");
    expect((await request(primary, "GET", "/seo")).statusCode).toBe(404);
    vi.stubEnv("ORBIT_SEO", "true");
  });

  it("applies project membership and module roles without exposing administrative actions", async () => {
    expect(
      (await request(primary, "GET", "/seo", undefined, "viewer")).json(),
    ).toMatchObject({ canManage: false });
    expect(
      (await request(primary, "POST", "/seo/websites", website, "editor"))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          primary,
          "POST",
          `/seo/providers/${provider}/connect`,
          {},
          "viewer",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${primary.projectId}/seo`,
          headers: { cookie: foreign.cookies.owner },
        })
      ).statusCode,
    ).toBe(404);

    await authDb.projectMemberModuleRole.create({
      data: {
        workspaceId: primary.workspaceId,
        projectId: primary.projectId,
        userId: primary.viewer.userId,
        moduleId: "seo",
        role: "none",
        changedBy: primary.owner.userId,
      },
    });
    try {
      expect(
        (await request(primary, "GET", "/seo", undefined, "viewer")).statusCode,
      ).toBe(404);
    } finally {
      await authDb.projectMemberModuleRole.deleteMany({
        where: { projectId: primary.projectId },
      });
    }
  });

  it("uses organization entitlements and serializes concurrent website creation at a quota", async () => {
    expect((await activate(foreign, true)).statusCode).toBe(200);
    setEntitlementsResolver((workspaceId) => ({
      ...defaultEntitlements(),
      ...(workspaceId === foreign.workspaceId
        ? { seoWebsitesMax: 1 }
        : { modulesAllowed: new Set(["knowledge"]) }),
    }));
    expect((await request(primary, "GET", "/seo")).json().error.code).toBe(
      "SEO_ENTITLEMENT_REQUIRED",
    );
    const results = await Promise.all([
      createSite(foreign),
      createSite(foreign, {
        name: "Quota race",
        url: "https://quota.example.invalid",
      }),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      201, 409,
    ]);
    expect(
      results.find((result) => result.statusCode === 409)!.json().error.code,
    ).toBe("SEO_WEBSITE_LIMIT");
    const onlySite = results
      .find((result) => result.statusCode === 201)!
      .json();
    expect(
      (await request(foreign, "DELETE", `/seo/websites/${onlySite.id}`))
        .statusCode,
    ).toBe(204);
    expect((await createSite(foreign)).statusCode).toBe(201);
  });

  it("binds only provider-confirmed properties using the selected project's account and reads real transport results", async () => {
    const admin = { role: "admin" as const, userId: `test-${randomUUID()}` };
    const clientId = "synthetic-seo.apps.googleusercontent.com";
    const connection = await createConnection(admin, {
      provider: "seo.app.google-search-console",
      label: "Synthetic SEO OAuth app",
      config: {},
      secret: JSON.stringify({ clientId, clientSecret: "synthetic-app-value" }),
    });
    appConnectionId = connection.id;
    for (const project of [primary, foreign]) {
      for (const projectId of [undefined, project.projectId]) {
        await grantConnection(admin, appConnectionId, {
          workspaceId: project.workspaceId,
          ...(projectId ? { projectId } : {}),
          modules: ["seo"],
          purposes: ["seo_oauth"],
        });
      }
    }
    const connected = await Promise.all(
      [primary, foreign].map((project) =>
        createProjectConnection(project.owner, {
          moduleId: "seo",
          provider: "seo.account.google-search-console",
          label: "Synthetic Search Console",
          config: { appConnectionId },
          purposes: ["seo_read"],
          secret: JSON.stringify({
            clientId,
            refreshToken: "synthetic-refresh-value",
          }),
        }),
      ),
    );
    const connectionId = connected[0]!.connectionId;
    const foreignConnectionId = connected[1]!.connectionId;
    let reportGate: { reached: () => void; wait: Promise<void> } | undefined;
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "synthetic-access-value" });
      expect(init.headers).toMatchObject({
        Authorization: "Bearer synthetic-access-value",
      });
      if (url === "https://www.googleapis.com/webmasters/v3/sites")
        return Response.json({
          siteEntry: [
            { siteUrl: propertyId, permissionLevel: "siteOwner" },
            {
              siteUrl: "sc-domain:unverified.example.invalid",
              permissionLevel: "siteUnverifiedUser",
            },
          ],
        });
      expect(url).toBe(
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyId)}/searchAnalytics/query`,
      );
      expect(JSON.parse(String(init.body))).toMatchObject({
        startDate: "2026-11-01",
        endDate: "2026-11-10",
        dimensions: ["query"],
        rowLimit: 10,
      });
      reportGate?.reached();
      await reportGate?.wait;
      return Response.json({
        rows: [
          {
            keys: ["example"],
            clicks: 1,
            impressions: 10,
            ctr: 0.1,
            position: 3.2,
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    const status = await request(primary, "GET", "/seo");
    expect(status.json().providers[0]).toMatchObject({
      appReady: true,
      connections: [{ id: connectionId, unavailable: false }],
    });
    expect(
      (await request(primary, "GET", "/seo", undefined, "viewer")).json()
        .providers[0].connections,
    ).toEqual([]);
    const siteId = status.json().websites[0].id;
    const binding = `/seo/websites/${siteId}/properties/${provider}`;
    const getPerformance = (project = primary, query = report) =>
      request(
        project,
        "GET",
        `/seo/websites/${siteId}/performance?${query}`,
        undefined,
        "viewer",
      );

    expect((await getPerformance()).json().error.code).toBe(
      "SEO_PROPERTY_NOT_LINKED",
    );
    expect(
      (
        await request(primary, "PUT", binding, {
          connectionId: foreignConnectionId,
          propertyId,
        })
      ).statusCode,
    ).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (
        await request(primary, "PUT", binding, {
          connectionId,
          propertyId: "sc-domain:unknown.example.invalid",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(primary, "PUT", binding, { connectionId, propertyId })
      ).json().properties,
    ).toEqual([{ provider, connectionId, propertyId }]);

    const reads = fetch.mock.calls.length;
    expect((await getPerformance(foreign)).statusCode).toBe(404);
    expect(
      (
        await getPerformance(
          primary,
          report.replace("2026-11-01", "2026-01-01"),
        )
      ).statusCode,
    ).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(reads);
    expect((await getPerformance()).json()).toEqual({
      provider,
      websiteId: siteId,
      startDate: "2026-11-01",
      endDate: "2026-11-10",
      dimension: "query",
      rows: [
        {
          keys: ["example"],
          clicks: 1,
          impressions: 10,
          ctr: 0.1,
          position: 3.2,
        },
      ],
    });
    let finishReport!: () => void;
    const wait = new Promise<void>((resolve) => {
      finishReport = resolve;
    });
    let startReport!: () => void;
    const requested = new Promise<void>((resolve) => {
      startReport = resolve;
    });
    reportGate = { reached: startReport, wait };
    const pending = getPerformance();
    try {
      await Promise.race([
        requested,
        pending.then((response) => {
          throw new Error(
            `Report did not reach Google: ${response.statusCode}`,
          );
        }),
      ]);
      expect((await activate(primary, false)).statusCode).toBe(200);
    } finally {
      finishReport();
    }
    expect((await pending).statusCode).toBe(404);
    expect((await activate(primary, true)).statusCode).toBe(200);

    const events = await primary.run((tx) =>
      tx.auditEvent.findMany({
        where: { resourceId: siteId, action: "seo.property_bound" },
      }),
    );
    expect(events.map((event) => event.metadata)).toEqual([{ provider }]);
    expect((await request(primary, "DELETE", binding)).statusCode).toBe(204);
    expect((await getPerformance()).json().error.code).toBe(
      "SEO_PROPERTY_NOT_LINKED",
    );
  });
});
