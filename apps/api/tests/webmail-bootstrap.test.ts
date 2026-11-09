import { describe, expect, it, vi } from "vitest";
import {
  bridgeLogger,
  buildDisabledBridgeApp,
  createWebmailBridgeProcess,
} from "../src/modules/webmail/bridge-bootstrap.ts";

const off = {
  ORBIT_WEBMAIL: "false",
  WEBMAIL_ORIGIN: "",
  WEBMAIL_BRIDGE_SECRET: "",
} as const;
const on = {
  ORBIT_WEBMAIL: "true",
  WEBMAIL_ORIGIN: "https://webmail.example.invalid",
  WEBMAIL_BRIDGE_SECRET: "synthetic",
} as const;

/** The bridge process (ADR 0026): health-only and loading nothing while off. */
describe("webmail bridge process", () => {
  it("stays health-only while webmail is off and loads nothing", async () => {
    const load = vi.fn();
    const { app, mode, closers } = await createWebmailBridgeProcess(off, {
      loadEnabled: load,
    });
    expect(mode).toBe("disabled");
    expect(closers).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "disabled" });
    await app.close();
  });

  it.each([
    { ...on, ORBIT_WEBMAIL: "false" },
    { ...on, WEBMAIL_ORIGIN: "" },
    { ...on, WEBMAIL_BRIDGE_SECRET: "" },
  ] as const)(
    "is off unless flag, origin and secret are all set (%#)",
    async (config) => {
      const load = vi.fn();
      const { mode, app } = await createWebmailBridgeProcess(config, {
        loadEnabled: load,
      });
      expect(mode).toBe("disabled");
      expect(load).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("answers everything else with a bare 404 before reading a body", async () => {
    const app = await buildDisabledBridgeApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/session/authorize",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("");
    await app.close();
  });

  it("logs the method and path only, never a query, header or body", () => {
    const logged = bridgeLogger.serializers.req({
      method: "POST",
      url: "/v1/session/authorize?handle=secret",
      headers: { authorization: "Bearer secret" },
      body: { handle: "secret" },
    } as { method: string; url: string });
    expect(logged).toEqual({ method: "POST", path: "/v1/session/authorize" });
  });

  it("registers the modules before serving, and serves health when on", async () => {
    const register = vi.fn(async () => undefined);
    const process = await createWebmailBridgeProcess(on, { register });
    expect(process.mode).toBe("enabled");
    expect(register).toHaveBeenCalledOnce();
    const health = await process.app.inject({ method: "GET", url: "/healthz" });
    expect(health.json()).toEqual({ status: "ok" });
    await process.app.close();
  });

  it("loads the bridge when webmail is on", async () => {
    const app = await buildDisabledBridgeApp();
    const closer = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({ app, closers: [closer] }));
    const process = await createWebmailBridgeProcess(on, { loadEnabled: load });
    expect(process.mode).toBe("enabled");
    expect(load).toHaveBeenCalledOnce();
    expect(process.closers).toEqual([closer]);
    await app.close();
  });
});
