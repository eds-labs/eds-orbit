import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PassThrough } from "node:stream";
import { buildServer } from "../src/server.ts";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("Structured redacted API logging", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const stream = new PassThrough();
  let raw = "";
  stream.on("data", (chunk) => (raw += chunk.toString()));
  const lines = () =>
    raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
  const previousLevel = process.env.LOG_LEVEL;

  beforeAll(async () => {
    // tests/setup.ts silences the default logger; this suite opts back in.
    process.env.LOG_LEVEL = "info";
    app = await buildServer(undefined, { logStream: stream });
  });
  afterAll(async () => {
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
    await app?.close();
    await closeDatabase();
  });

  it("logs path, request id and status without query or credential values", async () => {
    raw = "";
    const response = await app.inject({
      method: "GET",
      url: "/api/google-drive/callback?code=secret-code&state=secret-state",
      headers: {
        cookie: "orbit.session_token=secret-cookie",
        authorization: "Bearer secret-token",
        "x-request-id": "attacker-chosen-id",
      },
    });
    const output = raw;
    for (const secret of [
      "secret-code",
      "secret-state",
      "secret-cookie",
      "secret-token",
    ])
      expect(output).not.toContain(secret);
    const all = lines();
    const incoming = all.find((line) => line.msg === "incoming request");
    const completed = all.find((line) => line.msg === "request completed");
    expect(incoming?.req.path).toBe("/api/google-drive/callback");
    expect(incoming?.req.id).toBe(incoming?.reqId);
    expect(completed?.reqId).toBe(incoming?.reqId);
    expect(completed?.reqId).toEqual(expect.any(String));
    expect(completed?.reqId).not.toBe("attacker-chosen-id");
    expect(completed?.res.statusCode).toBe(response.statusCode);
    expect(output).not.toContain("attacker-chosen-id");
  });

  // Keys pino and Fastify add to every line; anything else is payload.
  const standard = new Set([
    "level",
    "time",
    "pid",
    "hostname",
    "reqId",
    "msg",
  ]);
  const payloadKeys = (line: Record<string, unknown> | undefined) =>
    Object.keys(line ?? {})
      .filter((key) => !standard.has(key))
      .sort();

  it("logs handled failures at warn with the response code and status only", async () => {
    raw = "";
    const response = await app.inject({
      method: "GET",
      url: "/api/google-drive/callback?code=secret-code&state=secret-state",
    });
    const failure = lines().find((line) => line.msg === "request failed");
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    expect(failure?.level).toBe(40);
    expect(failure?.code).toBe("VALIDATION_FAILED");
    expect(failure?.status).toBe(response.statusCode);
    expect(payloadKeys(failure)).toEqual(["code", "status"]);
    expect(raw).not.toContain("secret-code");
    expect(raw).not.toContain("secret-state");
  });

  it("logs unexpected 5xx failures at error with errorName but never the message", async () => {
    raw = "";
    const spy = vi
      .spyOn(authDb.workspace, "count")
      .mockRejectedValueOnce(new Error("boom-secret-message"));
    try {
      const response = await app.inject("/api/setup");
      const failure = lines().find((line) => line.msg === "request failed");
      expect(response.statusCode).toBe(500);
      expect(failure?.level).toBe(50);
      expect(failure?.code).toBe("REQUEST_FAILED");
      expect(failure?.status).toBe(500);
      expect(failure?.errorName).toBe("Error");
      expect(payloadKeys(failure)).toEqual(["code", "errorName", "status"]);
      expect(raw).not.toContain("boom-secret-message");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps health probes out of info logs", async () => {
    raw = "";
    const response = await app.inject("/health");
    expect(response.statusCode).toBe(200);
    expect(lines().filter((line) => line.level <= 30)).toEqual([]);
  });
});
