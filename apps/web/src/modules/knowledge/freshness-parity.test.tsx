import { describe, expect, it } from "vitest";
import { listedSource, sourceExpiry as webSourceExpiry } from "./overview";
import {
  sourceExpiry,
  tracksFreshness,
} from "../../../../../packages/knowledge/src/freshness";

// The server's attention items and the web's knowledge overview must agree
// on when a source is fresh, expiring or stale (Ruling R14). The web keeps
// its own copy, so this test is what stops them drifting apart. It lives
// here, not under packages, because the root typecheck cannot resolve the
// web's "@/" alias.

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const CASES: Record<string, Record<string, unknown>> = {
  fresh: { lastSuccessfulSyncAt: ago(24), maxAgeHours: 168 },
  "expiring within 48 h": {
    lastSuccessfulSyncAt: ago(7 * 24 - 1),
    maxAgeHours: 168,
  },
  "exactly 48 h left": {
    lastSuccessfulSyncAt: ago(5 * 24),
    maxAgeHours: 168,
  },
  "just past 48 h left": {
    lastSuccessfulSyncAt: ago(5 * 24 - 1),
    maxAgeHours: 168,
  },
  "exactly at expiry": { lastSuccessfulSyncAt: ago(168), maxAgeHours: 168 },
  stale: { lastSuccessfulSyncAt: ago(9 * 24), maxAgeHours: 168 },
  "never synced": { lastSuccessfulSyncAt: null, maxAgeHours: 168 },
  "no sync field": { maxAgeHours: 168 },
  "unparsable sync": { lastSuccessfulSyncAt: "yesterday", maxAgeHours: 168 },
  "default maxAgeHours 168": { lastSuccessfulSyncAt: ago(7 * 24 - 1) },
  "zero maxAgeHours uses the default": {
    lastSuccessfulSyncAt: ago(24),
    maxAgeHours: 0,
  },
  "short maxAgeHours": { lastSuccessfulSyncAt: ago(2), maxAgeHours: 1 },
  "revoked and stale": {
    status: "revoked",
    lastSuccessfulSyncAt: null,
    maxAgeHours: 168,
  },
  "manually maintained facts, never synced": {
    type: "verified_facts",
    status: "active",
  },
  "manually maintained facts with an old sync": {
    type: "verified_facts",
    lastSuccessfulSyncAt: ago(9 * 24),
    maxAgeHours: 1,
  },
  active: { status: "active", lastSuccessfulSyncAt: ago(1) },
};

describe("source freshness parity (server and web)", () => {
  it("does not apply synchronization expiry to manually maintained facts", () => {
    for (const source of [
      CASES["manually maintained facts, never synced"],
      CASES["manually maintained facts with an old sync"],
    ]) {
      expect(sourceExpiry(source!, NOW)).toEqual({
        state: "manual",
        expiresAt: null,
      });
    }
  });

  for (const [name, source] of Object.entries(CASES))
    it(`agrees on ${name}`, () => {
      expect(sourceExpiry(source, NOW)).toEqual(webSourceExpiry(source, NOW));
      // A revoked source is left out on both sides.
      expect(tracksFreshness(source)).toBe(listedSource({ data: source }));
    });

  it("covers every state", () => {
    const states = new Set(
      Object.values(CASES).map((source) => sourceExpiry(source, NOW).state),
    );
    expect([...states].sort()).toEqual([
      "expiring",
      "fresh",
      "manual",
      "stale",
    ]);
    expect(Object.values(CASES).some((s) => !tracksFreshness(s))).toBe(true);
  });
});
