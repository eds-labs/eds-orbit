import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const call = async (headers: Record<string, string>) => {
  const forwarded: Headers[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: URL, init: RequestInit) => {
      forwarded.push(new Headers(init.headers));
      return new Response("{}", { status: 200 });
    }),
  );
  const request = new NextRequest("https://orbit.example/api/telegram/p/c", {
    method: "POST",
    headers,
    body: "{}",
  });
  await POST(request, {
    params: Promise.resolve({ path: ["telegram", "p", "c"] }),
  });
  return forwarded[0]!;
};

describe("API proxy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards Telegram's webhook secret header to the API", async () => {
    const headers = await call({
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "s3cret",
    });
    expect(headers.get("x-telegram-bot-api-secret-token")).toBe("s3cret");
  });

  it("forwards an EventSource's Last-Event-ID so a reconnect resumes", async () => {
    const headers = await call({ "last-event-id": "42" });
    expect(headers.get("last-event-id")).toBe("42");
  });

  it("drops headers outside its allow-list", async () => {
    const headers = await call({ authorization: "Bearer x", "x-other": "1" });
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-other")).toBeNull();
  });

  it("forwards the right-most X-Forwarded-For hop as the client address", async () => {
    const headers = await call({
      "x-forwarded-for": "203.0.113.9, 198.51.100.7",
    });
    expect(headers.get("x-orbit-client-ip")).toBe("198.51.100.7");
    expect(headers.get("x-forwarded-for")).toBeNull();
  });

  it("forwards an IPv6 client address", async () => {
    const headers = await call({ "x-forwarded-for": "2001:db8::1" });
    expect(headers.get("x-orbit-client-ip")).toBe("2001:db8::1");
  });

  it("never passes on a client address the browser sent itself", async () => {
    const headers = await call({
      "x-orbit-client-ip": "203.0.113.9",
      "x-forwarded-for": "198.51.100.7",
    });
    expect(headers.get("x-orbit-client-ip")).toBe("198.51.100.7");
    const unknown = await call({ "x-orbit-client-ip": "203.0.113.9" });
    expect(unknown.get("x-orbit-client-ip")).toBeNull();
  });

  it("sends no client address when the last hop is not an IP", async () => {
    for (const value of ["198.51.100.7, unknown", "198.51.100.7,", "x"]) {
      const headers = await call({ "x-forwarded-for": value });
      expect(headers.get("x-orbit-client-ip")).toBeNull();
    }
  });
});
