import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Records project transactions opened while a connection's secret lock is
// held. The lock order is project before connection: a refresh that waited
// for the project lock while holding its connection lock would keep an
// auth connection busy and could lose a rotated, single-use refresh token
// to the transaction timeout.
const probe = vi.hoisted(() => ({ inside: false, scopedInside: 0 }));
vi.mock("../../../packages/db/src/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../packages/db/src/index.ts")>();
  return {
    ...actual,
    scoped: ((...args: Parameters<typeof actual.scoped>) => {
      if (probe.inside) probe.scopedInside++;
      return actual.scoped(...args);
    }) as typeof actual.scoped,
  };
});
vi.mock("../src/platform/connections/project-secrets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/platform/connections/project-secrets.ts")>();
  return {
    ...actual,
    withProjectSecret: ((scope, input, work) =>
      actual.withProjectSecret(scope, input, async (current) => {
        probe.inside = true;
        try {
          return await work(current);
        } finally {
          probe.inside = false;
        }
      })) as typeof actual.withProjectSecret,
  };
});

import { closeDatabase } from "../../../packages/db/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import { saveConnectedAccount } from "../src/modules/social/accounts/store.ts";
import { accountCredentials } from "../src/modules/social/accounts/vault.ts";
import { grantSocialApp, removeProjectConnections, X_APP_SECRET } from "./support/social-apps.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);

describe.skipIf(!enabled)("social token refresh and locks", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let cleanupApp: () => Promise<unknown>;

  beforeAll(async () => {
    process.env.ORBIT_CONNECTIONS = "true";
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    cleanupApp = (await grantSocialApp(p, "social.app.x", X_APP_SECRET)).cleanup;
  });
  afterAll(async () => {
    setSocialFetchForTests(null);
    await removeProjectConnections(p);
    await cleanupApp?.();
    await p?.cleanup();
    await closeDatabase();
  });

  it("opens no project transaction while it holds the connection lock", async () => {
    const { accountId } = await saveConnectedAccount(p.owner, {
      platform: "x",
      externalId: "lock-1",
      handle: "@lock",
      displayName: "Lock",
      secret: JSON.stringify({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scopes: [],
      }),
      config: { userId: "lock-1" },
    });
    let calls = 0;
    setSocialFetchForTests(async () => {
      calls++;
      return new Response(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect((await accountCredentials(p.owner, accountId)).accessToken).toBe("access-2");
    expect(calls).toBe(1);
    expect(probe.scopedInside).toBe(0);
  });
});
