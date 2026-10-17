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
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORBIT_API_ORIGIN;
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
      ["oauth-protected-resource"],
      ["oauth-authorization-server"],
      ["oauth-authorization-server", "api", "auth", "extra"],
      ["oauth-authorization-server", "api", "other"],
      ["oauth-authorization-server", "..", "auth"],
      ["oauth-authorization-server/api/auth/x"],
    ])
      expect((await call(path)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the API is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down"));
    const r = await call(["oauth-authorization-server", "api", "auth"]);
    expect(r.status).toBe(502);
  });
});
