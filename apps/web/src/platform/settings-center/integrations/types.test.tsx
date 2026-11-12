import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INTEGRATION_AUTH_TYPES,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATES,
} from "./types";

// The web copy of the three value lists must equal the API's, in order.
const api = readFileSync(
  "apps/api/src/platform/connections/integrations.ts",
  "utf8",
);
const listOf = (name: string): string[] => {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(api);
  expect(match, `${name} not found in the API source`).not.toBeNull();
  return [...match![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
};

describe("integration vocabulary", () => {
  it("matches the API lists", () => {
    expect([...INTEGRATION_STATES]).toEqual(listOf("INTEGRATION_STATES"));
    expect([...INTEGRATION_CATEGORIES]).toEqual(listOf("INTEGRATION_CATEGORIES"));
    expect([...INTEGRATION_AUTH_TYPES]).toEqual(listOf("INTEGRATION_AUTH_TYPES"));
  });
});
