import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AI_ORIGINS,
  AI_PROVIDERS,
  ANTHROPIC_TIERS,
  KEY_NAMES,
  OPENAI_TIERS,
  READINESS_REASONS,
  ROUTING_MODES,
} from "./types";

// The web copy of the effective AI view must equal the API's: the same value
// lists in order and the same field names.
const effective = readFileSync(
  "apps/api/src/platform/management/ai-effective.ts",
  "utf8",
);
const configuration = readFileSync(
  "apps/api/src/platform/ai/effective-configuration.ts",
  "utf8",
);
const web = readFileSync(
  "apps/web/src/platform/settings-center/ai/types.ts",
  "utf8",
);

const strings = (text: string) =>
  [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
const union = (source: string, name: string) => {
  const match = new RegExp(`export type ${name} =([^;]*);`).exec(source);
  expect(match, `${name} not found`).not.toBeNull();
  return strings(match![1]!);
};
const list = (source: string, name: string) => {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const`).exec(
    source,
  );
  expect(match, `${name} not found`).not.toBeNull();
  return strings(match![1]!);
};
/** The field names of a type's top level (two-space indented lines). */
const fields = (source: string, name: string) => {
  const match = new RegExp(
    `export type ${name} = \\{\\n([\\s\\S]*?)\\n\\};`,
  ).exec(source);
  expect(match, `${name} not found`).not.toBeNull();
  return [...match![1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
};

describe("effective AI vocabulary", () => {
  it("matches the API lists", () => {
    expect([...AI_ORIGINS]).toEqual(union(effective, "AiOrigin"));
    expect([...READINESS_REASONS]).toEqual(union(effective, "ReadinessReason"));
    expect([...ROUTING_MODES]).toEqual(union(configuration, "RoutingMode"));
    expect([...OPENAI_TIERS]).toEqual(list(effective, "OPENAI_TIERS"));
    expect([...ANTHROPIC_TIERS]).toEqual(list(effective, "ANTHROPIC_TIERS"));
    expect([...AI_PROVIDERS]).toEqual(list(effective, "PROVIDERS"));
    expect([...KEY_NAMES]).toEqual(list(effective, "KEY_NAMES"));
  });

  it("names the same fields as the API types", () => {
    for (const name of [
      "ProjectAiEffective",
      "TracedRoute",
      "KeyTrace",
      "ProviderReadiness",
      "ProviderBudgetValue",
    ]) {
      const api = fields(effective, name);
      expect(api.length, name).toBeGreaterThan(2);
      expect(fields(web, name), name).toEqual(api);
    }
  });

  it("names the same members of exceptions and of a key's connection", () => {
    const members = (block: string) =>
      [...block.matchAll(/(\w+)\??:/g)].map((m) => m[1]!);
    const exceptionsApi =
      /export function projectAiExceptions\([\s\S]*?\): \{([\s\S]*?)\n\} \{/.exec(
        configuration,
      );
    expect(exceptionsApi, "projectAiExceptions not found").not.toBeNull();
    const exceptionsWeb = /\n {2}exceptions: \{([\s\S]*?)\n {2}\};/.exec(web);
    expect(exceptionsWeb, "web exceptions not found").not.toBeNull();
    const api = members(exceptionsApi![1]!);
    expect(api).toEqual([
      "models",
      "routes",
      "prices",
      "providerBudgets",
      "keys",
    ]);
    expect(members(exceptionsWeb![1]!)).toEqual(api);

    const connection = (source: string) => {
      const match = /\n {2}connection: \{([^}]*)\} \| null;/.exec(source);
      expect(match, "connection not found").not.toBeNull();
      return members(match![1]!);
    };
    expect(connection(effective)).toEqual(["label", "status", "disabled"]);
    expect(connection(web)).toEqual(connection(effective));
  });
});
