import { describe, expect, it } from "vitest";
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { APIError as AnthropicApiError } from "@anthropic-ai/sdk";
import { isRejectedRequest, rejectionCode, rejectionDetail, TEMPORARY_REJECTIONS } from "./index.ts";

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

describe("why a provider refused a request", () => {
  const anthropic = (code: number, type: string) =>
    AnthropicApiError.generate(code, { type: "error", error: { type, message: "synthetic" } }, "synthetic", new Headers({ "request-id": "req_1" }));
  it.each([
    [429, "MODEL_RATE_LIMITED"],
    [401, "MODEL_AUTH_REJECTED"],
    [403, "MODEL_AUTH_REJECTED"],
    [404, "MODEL_NOT_AVAILABLE"],
    [400, "MODEL_REQUEST_INVALID"],
    [422, "MODEL_REQUEST_INVALID"],
  ])("names OpenAI HTTP %i as %s", (code, expected) => {
    expect(rejectionCode(status(code))).toBe(expected);
  });
  it("names Anthropic's overload, its request field refusals and its request id", () => {
    expect(rejectionCode(anthropic(529, "overloaded_error"))).toBe("MODEL_OVERLOADED");
    expect(rejectionCode(anthropic(413, "request_too_large"))).toBe("MODEL_REQUEST_INVALID");
    expect(rejectionDetail(anthropic(529, "overloaded_error"))).toEqual({ code: "529 overloaded_error: synthetic", requestId: "req_1" });
    expect(TEMPORARY_REJECTIONS.has("MODEL_OVERLOADED")).toBe(true);
    expect(TEMPORARY_REJECTIONS.has("MODEL_REQUEST_INVALID")).toBe(false);
  });
  it("names nothing that was not a refusal", () => {
    expect(rejectionCode(status(500))).toBeNull();
    expect(rejectionCode(new Error("400"))).toBeNull();
  });
});
