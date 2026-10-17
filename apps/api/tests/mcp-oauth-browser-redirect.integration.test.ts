import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  cimdFetchFor,
  clientIp,
  metadata,
  pkce,
  REDIRECT_URI,
  SCOPES,
  withFlags,
} from "./mcp-oauth-flow-helpers.ts";

// Track M WP-M1, Task 3b: the web proxy's fetch always carries
// `Sec-Fetch-Mode: cors`, which makes Better Auth answer `{redirect:true,url}`
// JSON instead of a 302 for a browser navigation. The proxy therefore forwards
// the browser's real value in `x-orbit-sec-fetch-mode` and the API restores it
// (only with ORBIT_MCP_OAUTH=true, only from a trusted peer).

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const CLIENT_ID = "https://client.test/browser-redirect.json";
const cimdFetch = cimdFetchFor({ [CLIENT_ID]: metadata(CLIENT_ID) });
type App = Awaited<ReturnType<typeof buildServer>>;

const authorizeUrl = (resource: string) =>
  `/api/auth/oauth2/authorize?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES,
    state: "st-nav",
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource,
  })}`;

describe.skipIf(!enabled)(
  "browser redirects through the proxy, flag on",
  () => {
    let app: App;
    let resource: string;
    beforeAll(async () => {
      const built = await withFlags(
        { ORBIT_MCP_OAUTH: "true", ORBIT_MCP_CIMD_HOSTS: "client.test" },
        cimdFetch,
      );
      app = built.app;
      resource = built.config.MCP_RESOURCE;
    });
    afterAll(async () => {
      await app?.close();
      await closeDatabase();
    });

    const authorize = (
      headers: Record<string, string>,
      remoteAddress?: string,
    ) =>
      app.inject({
        url: authorizeUrl(resource),
        ...(remoteAddress ? { remoteAddress } : {}),
        headers: { [CLIENT_IP_HEADER]: clientIp(), ...headers },
      });

    it("sec-fetch-mode cors alone keeps the JSON answer", async () => {
      const r = await authorize({ "sec-fetch-mode": "cors" });
      expect(r.statusCode).toBe(200);
      expect(r.json().redirect).toBe(true);
      expect(new URL(r.json().url, "http://x").pathname).toBe("/connect/login");
    });

    it("x-orbit-sec-fetch-mode navigate turns the same request into a 302", async () => {
      const r = await authorize({
        "sec-fetch-mode": "cors",
        "x-orbit-sec-fetch-mode": "navigate",
      });
      expect(r.statusCode).toBe(302);
      expect(new URL(r.headers.location as string, "http://x").pathname).toBe(
        "/connect/login",
      );
    });

    it("x-orbit-sec-fetch-mode cors keeps the JSON answer even without sec-fetch-mode", async () => {
      const r = await authorize({ "x-orbit-sec-fetch-mode": "cors" });
      expect(r.statusCode).toBe(200);
      expect(r.json().redirect).toBe(true);
    });

    it("ignores unknown values and a header from an untrusted peer", async () => {
      const odd = await authorize({
        "sec-fetch-mode": "cors",
        "x-orbit-sec-fetch-mode": "navigate, cors",
      });
      expect(odd.statusCode).toBe(200);
      const untrusted = await authorize(
        { "sec-fetch-mode": "cors", "x-orbit-sec-fetch-mode": "navigate" },
        "203.0.113.5",
      );
      expect(untrusted.statusCode).toBe(200);
      expect(untrusted.json().redirect).toBe(true);
    });

    it("no proxy header: the request is left as it is", async () => {
      const r = await authorize({});
      expect(r.statusCode).toBe(302);
    });

    it("over a real socket, Node's fetch (always cors) gets the 302 with the proxy header", async () => {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const call = (extra: Record<string, string>) =>
        fetch(new URL(authorizeUrl(resource), base), {
          redirect: "manual",
          headers: { [CLIENT_IP_HEADER]: clientIp(), ...extra },
        });
      const plain = await call({});
      expect(plain.status).toBe(200);
      expect((await plain.json()).redirect).toBe(true);
      const navigated = await call({ "x-orbit-sec-fetch-mode": "navigate" });
      expect(navigated.status).toBe(302);
      expect(
        new URL(navigated.headers.get("location")!, "http://x").pathname,
      ).toBe("/connect/login");
    });
  },
);

describe.skipIf(!enabled)(
  "browser redirects through the proxy, flag off",
  () => {
    let app: App;
    beforeAll(async () => {
      ({ app } = await withFlags({ ORBIT_MCP_OAUTH: "false" }, cimdFetch));
    });
    afterAll(async () => {
      await app?.close();
      await closeDatabase();
    });

    it("the proxy header changes nothing: the endpoint stays closed", async () => {
      const r = await app.inject({
        url: authorizeUrl("https://x.test/mcp"),
        headers: {
          [CLIENT_IP_HEADER]: clientIp(),
          "sec-fetch-mode": "cors",
          "x-orbit-sec-fetch-mode": "navigate",
        },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("AUTH_ENDPOINT_DISABLED");
    });
  },
);
