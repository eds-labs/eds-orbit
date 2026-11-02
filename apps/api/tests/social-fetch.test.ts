import { afterEach, describe, expect, it } from "vitest";
import { setSocialFetchForTests, socialFetch } from "../src/modules/social/accounts/http.ts";

// The social module's transport (ADR 0020): a caller that brings its own
// deadline (Telegram media uploads, 60 s) keeps it; otherwise 20 s apply.

afterEach(() => setSocialFetchForTests(null));

describe("socialFetch", () => {
  it("keeps the caller's own deadline and adds one only when there is none (final review M6)", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    setSocialFetchForTests(async (_url, init = {}) => {
      seen.push(init.signal);
      return new Response("{}");
    });
    const own = new AbortController().signal;
    await socialFetch("https://api.example.invalid/a", { signal: own });
    await socialFetch("https://api.example.invalid/b");
    expect(seen[0]).toBe(own);
    expect(seen[1]).toBeInstanceOf(AbortSignal);
  });
});
