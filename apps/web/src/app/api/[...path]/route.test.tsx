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

  it("drops headers outside its allow-list", async () => {
    const headers = await call({ authorization: "Bearer x", "x-other": "1" });
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-other")).toBeNull();
  });
});
