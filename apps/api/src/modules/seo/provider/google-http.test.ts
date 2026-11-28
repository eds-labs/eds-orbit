import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeGoogleCode,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  listGoogleProperties,
  prepareGoogleQuery,
  prepareGoogleTokenRefresh,
  refreshGoogleToken,
} from "./google-http.ts";

const app = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const report = {
  connectionId: "test-connection",
  externalId: "https://www.example.test/path/",
  startDate: "2026-10-01",
  endDate: "2026-10-04",
  dimension: "page" as const,
  limit: 2,
};

afterEach(() => vi.unstubAllGlobals());

describe("Google Search Console transport", () => {
  it("exchanges an authorization code with PKCE and requires a renewable token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          scope: GOOGLE_SEARCH_CONSOLE_SCOPE,
        }),
      )
      .mockResolvedValueOnce(Response.json({ access_token: "short-lived" }));
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      code: "test-code",
      verifier: "test-verifier",
      redirectUri:
        "https://orbit.example.test/api/seo/oauth/callback/google-search-console",
    };

    await expect(exchangeGoogleCode(app, input)).resolves.toBe("refresh");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    });
    await expect(exchangeGoogleCode(app, input)).rejects.toMatchObject({
      code: "SEO_GOOGLE_OFFLINE_ACCESS_REQUIRED",
    });
  });

  it("returns a stable reconnect error for invalid refresh grants and refuses an altered scope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "invalid_grant",
            error_description: "private provider detail",
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "token",
          scope: "https://www.googleapis.com/auth/drive",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshGoogleToken(app, "refresh")).rejects.toMatchObject({
      code: "SEO_CONNECTION_RECONNECT_REQUIRED",
      message: "SEO_CONNECTION_RECONNECT_REQUIRED",
    });
    await expect(refreshGoogleToken(app, "refresh")).rejects.toMatchObject({
      code: "SEO_GOOGLE_SCOPE_MISSING",
    });
    expect(
      Object.fromEntries(fetchMock.mock.calls[0]![1].body as URLSearchParams),
    ).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh",
    });
  });

  it("coalesces only in-flight refreshes for the same connection and credential", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ access_token: "temporary" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const refresh = prepareGoogleTokenRefresh(
      "orbit-connection",
      app,
      "refresh",
    );
    const same = prepareGoogleTokenRefresh("orbit-connection", app, "refresh");
    const other = prepareGoogleTokenRefresh("other-connection", app, "refresh");
    const rotated = prepareGoogleTokenRefresh(
      "orbit-connection",
      app,
      "new-refresh",
    );

    const results = await Promise.all([refresh(), same(), other(), rotated()]);

    expect(results).toEqual(Array(4).fill("temporary"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await refresh();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("lists only distinct readable Domain and URL-prefix properties", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        siteEntry: [
          { siteUrl: "sc-domain:example.test", permissionLevel: "siteOwner" },
          {
            siteUrl: "https://example.test/prefix/",
            permissionLevel: "siteRestrictedUser",
          },
          {
            siteUrl: "https://example.test/prefix/",
            permissionLevel: "siteFullUser",
          },
          {
            siteUrl: "https://unverified.test/",
            permissionLevel: "siteUnverifiedUser",
          },
          {
            siteUrl: "https://user:password@example.test/",
            permissionLevel: "siteOwner",
          },
          {
            siteUrl: "https://new-permission.test/",
            permissionLevel: "unknown",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(listGoogleProperties("access")).resolves.toEqual([
      { externalId: "sc-domain:example.test", label: "example.test" },
      {
        externalId: "https://example.test/prefix/",
        label: "https://example.test/prefix/",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.googleapis.com/webmasters/v3/sites",
      expect.objectContaining({
        headers: { Authorization: "Bearer access" },
        redirect: "error",
      }),
    );
  });

  it("calls bounded read-only Search Analytics using the encoded property on Google's host", async () => {
    const row = {
      keys: ["https://example.test/path/"],
      clicks: 1,
      impressions: 5,
      ctr: 0.2,
      position: 3.5,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ rows: [row], responseAggregationType: "byPage" }),
      )
      .mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareGoogleQuery(report)("access")).resolves.toEqual({
      rows: [row],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.example.test%2Fpath%2F/searchAnalytics/query",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer access",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(init.body as string)).toEqual({
      startDate: report.startDate,
      endDate: report.endDate,
      dimensions: ["page"],
      rowLimit: 2,
      type: "web",
      dataState: "final",
    });
    const { dimension: _dimension, ...totalsReport } = report;
    await expect(prepareGoogleQuery(totalsReport)("access")).resolves.toEqual({
      rows: [],
    });
    expect(
      JSON.parse(fetchMock.mock.calls[1]![1].body as string),
    ).not.toHaveProperty("dimensions");
  });

  it("distinguishes a Google quota response from a property permission error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { errors: [{ reason: "quotaExceeded" }] } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "private provider detail" } },
          { status: 403 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const query = prepareGoogleQuery(report);

    await expect(query("access")).rejects.toMatchObject({
      code: "SEO_PROVIDER_RATE_LIMITED",
    });
    await expect(query("access")).rejects.toMatchObject({
      code: "SEO_PROPERTY_INACCESSIBLE",
      message: "SEO_PROPERTY_INACCESSIBLE",
    });
  });

  it("rejects malformed input and malformed or oversized provider results", async () => {
    expect(() =>
      prepareGoogleQuery({ ...report, startDate: "2026-02-30" }),
    ).toThrow("SEO_REPORT_INPUT_INVALID");
    expect(() =>
      prepareGoogleQuery({ ...report, endDate: "2026-09-30" }),
    ).toThrow("SEO_REPORT_INPUT_INVALID");
    expect(() =>
      prepareGoogleQuery({ ...report, externalId: "file:///etc/hosts" }),
    ).toThrow("SEO_REPORT_INPUT_INVALID");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        rows: [{ keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(prepareGoogleQuery(report)("access")).rejects.toMatchObject({
      code: "SEO_GOOGLE_REQUEST_FAILED",
    });
  });
});
