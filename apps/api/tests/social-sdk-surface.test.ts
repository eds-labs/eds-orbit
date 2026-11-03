import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as root from "@opencoredev/social-sdk";
import * as server from "@opencoredev/social-sdk/server";

// What the social module takes from the SDK (ADR 0020, S-D1): direct
// adapters and OAuth helpers only. No managed publishing provider may be
// reachable through the entries Orbit imports.
const MANAGED = /zernio|postfast|post-?for-?me|postiz|buffer|upload-?post/i;
// /server ships two pure webhook signature checks for managed providers
// (no network, no import of cloud/*). Pinned, so an upgrade that adds a
// managed export fails here, and never used by Orbit (scan below).
const KNOWN_INERT = ["verifyPostForMeWebhook", "verifyZernioWebhook"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}

describe("@opencoredev/social-sdk surface", () => {
  it("offers the X OAuth provider and token refresh on /server", () => {
    expect(typeof server.xOAuth).toBe("function");
    expect(typeof server.refreshOAuthToken).toBe("function");
  });

  it("exports no managed provider from the root entry", () => {
    expect(Object.keys(root).filter((name) => MANAGED.test(name))).toEqual([]);
  });

  it("exports only the two known, inert managed webhook checks from /server", () => {
    expect(Object.keys(server).filter((name) => MANAGED.test(name)).sort()).toEqual(KNOWN_INERT);
  });

  it("never uses the managed webhook checks in Orbit's code", () => {
    const repo = new URL("../../../", import.meta.url).pathname;
    const offenders = ["apps/api/src", "apps/worker/src", "packages"].flatMap((dir) =>
      sources(join(repo, dir)).filter((file) =>
        KNOWN_INERT.some((name) => readFileSync(file, "utf8").includes(name)),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
