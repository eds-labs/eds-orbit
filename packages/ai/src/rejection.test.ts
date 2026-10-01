import { describe, expect, it } from "vitest";
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { isRejectedRequest } from "./index.ts";

const status = (code: number | undefined) =>
  APIError.generate(
    code,
    { error: { message: "synthetic" } },
    "synthetic",
    new Headers(),
  );

describe("rejected provider requests", () => {
  it.each([400, 401, 403, 404, 422, 429])(
    "treats HTTP %i as rejected before any model work",
    (code) => {
      expect(isRejectedRequest(status(code))).toBe(true);
    },
  );
  it.each([408, 409, 500, 502, 503])(
    "keeps HTTP %i as an unknown outcome",
    (code) => {
      expect(isRejectedRequest(status(code))).toBe(false);
    },
  );
  it("keeps stream errors, timeouts, aborts and other errors unknown", () => {
    // A stream error event carries no HTTP status.
    expect(isRejectedRequest(status(undefined))).toBe(false);
    expect(isRejectedRequest(new APIConnectionTimeoutError())).toBe(false);
    expect(isRejectedRequest(new APIUserAbortError())).toBe(false);
    expect(isRejectedRequest(new Error("400 Bad Request"))).toBe(false);
    expect(isRejectedRequest(null)).toBe(false);
  });
});
