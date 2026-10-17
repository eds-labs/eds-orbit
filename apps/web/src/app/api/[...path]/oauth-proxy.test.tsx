import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  process.env.ORBIT_API_ORIGIN = "http://api.internal:4311";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORBIT_API_ORIGIN;
});

const call = (
  handler: typeof GET,
  path: string[],
  init: ConstructorParameters<typeof NextRequest>[1] = {},
) =>
  handler(new NextRequest(`http://web.test/api/${path.join("/")}`, init), {
    params: Promise.resolve({ path }),
  });
const sentHeaders = () =>
  (fetchMock.mock.calls[0]![1] as RequestInit).headers as Headers;

describe("API proxy", () => {
  it("proxy forwards Authorization only under /api/auth/oauth2/", async () => {
    const headers = { authorization: "Bearer abc", cookie: "a=b" };
    await call(POST, ["auth", "oauth2", "token"], {
      method: "POST",
      headers,
      body: "grant_type=refresh_token",
    });
    expect(sentHeaders().get("authorization")).toBe("Bearer abc");
    expect(sentHeaders().get("cookie")).toBe("a=b");
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://api.internal:4311/api/auth/oauth2/token",
    );

    for (const path of [
      ["auth", "get-session"],
      ["auth", "oauth2x", "token"],
      ["projects", "p1", "content"],
      // One decoded segment is not the oauth2 prefix.
      ["auth/oauth2", "token"],
    ]) {
      fetchMock.mockClear();
      await call(GET, path, { headers });
      expect(sentHeaders().has("authorization")).toBe(false);
    }
  });

  it("passes the form content type and sets only the trusted client address", async () => {
    await call(POST, ["auth", "oauth2", "token"], {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": "203.0.113.9, 198.51.100.4",
        "x-orbit-client-ip": "192.0.2.1",
      },
      body: "grant_type=refresh_token",
    });
    expect(sentHeaders().get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(sentHeaders().get("x-orbit-client-ip")).toBe("198.51.100.4");
  });

  it("carries the browser's sec-fetch-mode in the proxy-only header on every path", async () => {
    // Node's fetch always sends sec-fetch-mode: cors upstream, which would turn
    // Better Auth's redirect for a browser navigation into JSON.
    await call(GET, ["auth", "oauth2", "authorize"], {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    });
    expect(sentHeaders().get("x-orbit-sec-fetch-mode")).toBe("navigate");
    expect(sentHeaders().has("sec-fetch-mode")).toBe(false);

    for (const path of [["auth", "sign-in", "email"], ["projects"]]) {
      fetchMock.mockClear();
      await call(GET, path, { headers: { "sec-fetch-mode": "cors" } });
      expect(sentHeaders().get("x-orbit-sec-fetch-mode")).toBe("cors");
    }
  });

  it("drops a browser-supplied x-orbit-sec-fetch-mode and sets none without sec-fetch-mode", async () => {
    await call(GET, ["auth", "oauth2", "authorize"], {
      headers: { "x-orbit-sec-fetch-mode": "navigate" },
    });
    expect(sentHeaders().has("x-orbit-sec-fetch-mode")).toBe(false);
    fetchMock.mockClear();
    await call(GET, ["auth", "oauth2", "authorize"], {
      headers: {
        "x-orbit-sec-fetch-mode": "navigate",
        "sec-fetch-mode": "cors",
      },
    });
    expect(sentHeaders().get("x-orbit-sec-fetch-mode")).toBe("cors");
  });

  it("rejects dot segments and answers 502 for an unusable upstream", async () => {
    expect((await call(GET, ["auth", ".."])).status).toBe(400);
    process.env.ORBIT_API_ORIGIN = "ftp://api.internal";
    expect((await call(GET, ["health"])).status).toBe(502);
    process.env.ORBIT_API_ORIGIN = "http://user:pw@api.internal";
    expect((await call(GET, ["health"])).status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
