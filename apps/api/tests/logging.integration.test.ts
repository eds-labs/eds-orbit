import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import { buildServer } from "../src/server.ts";
import { closeDatabase } from "../../../packages/db/src/index.ts";

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

  it("logs only the error code and class name, never messages", async () => {
    raw = "";
    await app.inject({
      method: "GET",
      url: "/api/google-drive/callback?code=secret-code&state=secret-state",
    });
    const failure = lines().find((line) => line.msg === "request failed");
    expect(failure).toBeDefined();
    expect(failure?.code).toEqual(expect.any(String));
    expect(Object.keys(failure ?? {})).not.toContain("err");
    expect(Object.keys(failure ?? {})).not.toContain("stack");
  });

  it("keeps health probes out of info logs", async () => {
    raw = "";
    const response = await app.inject("/health");
    expect(response.statusCode).toBe(200);
    expect(lines().filter((line) => line.level <= 30)).toEqual([]);
  });
});
