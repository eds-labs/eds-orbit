import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response('{"issuer":"x"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  process.env.ORBIT_API_ORIGIN = "http://api.internal:4311";
  process.env.ORBIT_MCP_ORIGIN = "http://mcp.internal:4312";
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORBIT_API_ORIGIN;
  delete process.env.ORBIT_MCP_ORIGIN;
});

const call = (path: string[], headers: Record<string, string> = {}) =>
  GET(
    new NextRequest(`http://web.test/.well-known/${path.join("/")}`, {
      headers,
    }),
    {
      params: Promise.resolve({ path }),
    },
  );

describe("well-known route", () => {
  it("well-known route forwards only the allowlisted paths", async () => {
    const ok = await call(["oauth-authorization-server", "api", "auth"], {
      authorization: "Bearer nope",
      cookie: "a=b",
      accept: "application/json",
      "x-forwarded-for": "198.51.100.4",
      "sec-fetch-mode": "navigate",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ issuer: "x" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://api.internal:4311/.well-known/oauth-authorization-server/api/auth",
    );
    const sent = (fetchMock.mock.calls[0]![1] as RequestInit)
      .headers as Headers;
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("x-orbit-client-ip")).toBe("198.51.100.4");
    expect(sent.get("x-orbit-sec-fetch-mode")).toBe("navigate");
    expect(sent.has("authorization")).toBe(false);
    expect(sent.has("cookie")).toBe(false);

    fetchMock.mockClear();
    for (const path of [
      ["openid-configuration"],
      ["oauth-authorization-server"],
      ["oauth-authorization-server", "api", "auth", "extra"],
      ["oauth-authorization-server", "api", "other"],
      ["oauth-authorization-server", "..", "auth"],
      ["oauth-authorization-server/api/auth/x"],
    ])
      expect((await call(path)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards exactly the two protected-resource paths to the MCP gateway", async () => {
    for (const [path, upstream] of [
      [["oauth-protected-resource"], "/.well-known/oauth-protected-resource"],
      [
        ["oauth-protected-resource", "mcp"],
        "/.well-known/oauth-protected-resource/mcp",
      ],
    ] as const) {
      fetchMock.mockClear();
      const ok = await call([...path], {
        authorization: "Bearer nope",
        cookie: "a=b",
        accept: "application/json",
        "user-agent": "probe",
        "x-forwarded-for": "198.51.100.4",
        "sec-fetch-mode": "navigate",
        origin: "https://evil.test",
      });
      expect(ok.status).toBe(200);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        `http://mcp.internal:4312${upstream}`,
      );
      const sent = (fetchMock.mock.calls[0]![1] as RequestInit)
        .headers as Headers;
      expect([...sent.keys()].sort()).toEqual(["accept", "user-agent"]);
    }

    fetchMock.mockClear();
    for (const path of [
      ["oauth-protected-resource", "other"],
      ["oauth-protected-resource", "mcp", "extra"],
      ["oauth-protected-resource", ".."],
      ["oauth-protected-resource/mcp"],
      ["oauth-protected-resource", "api", "auth"],
      ["oauth-protected-resource", "MCP"],
    ])
      expect((await call(path)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults the MCP origin to the compose service and rejects unsafe values", async () => {
    delete process.env.ORBIT_MCP_ORIGIN;
    await call(["oauth-protected-resource", "mcp"]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://mcp:4312/.well-known/oauth-protected-resource/mcp",
    );
    // An empty value (compose passes unset variables as "") is the default too.
    fetchMock.mockClear();
    process.env.ORBIT_MCP_ORIGIN = "";
    await call(["oauth-protected-resource"]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://mcp:4312/.well-known/oauth-protected-resource",
    );
    fetchMock.mockClear();
    for (const bad of ["ftp://mcp:4312", "http://user:pw@mcp:4312"]) {
      process.env.ORBIT_MCP_ORIGIN = bad;
      expect((await call(["oauth-protected-resource"])).status).toBe(502);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never passes cookies from the MCP gateway back to the browser", async () => {
    const answer = () => {
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "planted=1; Path=/");
      headers.append("set-cookie", "other=2; Path=/; HttpOnly");
      headers.set("set-cookie2", "legacy=1");
      headers.set("connection", "close");
      return new Response('{"resource":"x"}', { status: 200, headers });
    };
    for (const path of [
      ["oauth-protected-resource"],
      ["oauth-protected-resource", "mcp"],
    ]) {
      fetchMock.mockImplementationOnce(async () => answer());
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: "x" });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.has("set-cookie2")).toBe(false);
      expect(response.headers.has("connection")).toBe(false);
    }
    // The API's cookies are still passed through as before.
    fetchMock.mockImplementationOnce(async () => answer());
    const api = await call(["oauth-authorization-server", "api", "auth"]);
    expect(api.headers.getSetCookie()).toEqual([
      "planted=1; Path=/",
      "other=2; Path=/; HttpOnly",
    ]);
  });

  it("does not use the API origin for the protected-resource paths", async () => {
    await call(["oauth-protected-resource"]);
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain("api.internal");
  });

  it("answers 502 when the MCP gateway is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect((await call(["oauth-protected-resource", "mcp"])).status).toBe(502);
  });

  it("answers 502 within the short MCP timeout when the gateway hangs", async () => {
    // A hung upstream never answers; it only rejects once the signal aborts.
    fetchMock.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          ),
        ),
    );
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      requested.push(ms);
      return timeout(20); // stands in for the configured budget
    });
    try {
      const started = Date.now();
      const r = await call(["oauth-protected-resource", "mcp"]);
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({
        error: {
          code: "API_UNAVAILABLE",
          message: "The workspace service is unavailable. Try again shortly.",
        },
      });
      expect(Date.now() - started).toBeLessThan(2000);
      // The gateway's static documents get 5 s; the API keeps its 45 s.
      expect(requested).toEqual([5000]);
      await call(["oauth-authorization-server", "api", "auth"]);
      expect(requested).toEqual([5000, 45000]);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers 502 when the API is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const r = await call(["oauth-authorization-server", "api", "auth"]);
    expect(r.status).toBe(502);
  });
});
