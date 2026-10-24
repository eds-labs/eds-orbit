import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkBoundaries,
  checkForbiddenLiterals,
  classify,
  compareBaseline,
  parseImports,
  resolveImport,
  ruleFor,
} from "./boundaries.mjs";

const config = {
  zones: {
    "root:api": ["apps/api/src/server.ts"],
    platform: ["apps/api/src/platform/", "apps/api/src/modules/chat.ts"],
    "module:knowledge": ["apps/api/src/modules/knowledge/"],
    "module:marketing": ["apps/api/src/modules/", "apps/api/src/modules/marketing/"],
    worker: ["apps/worker/src/"],
    "web-platform": ["apps/web/src/", "apps/web/src/components/orbit.tsx"],
    "web-module:marketing": ["apps/web/src/components/"],
    "web-module:knowledge": ["apps/web/src/components/knowledge.tsx"],
    "package:db": ["packages/db/"],
    "package:schemas": ["packages/schemas/"],
  },
  dependencies: { "module:marketing": ["module:knowledge"] },
  serverPackages: ["package:db"],
};
const packages = { "@orbit/db": "packages/db/src/index.ts" };

describe("parseImports", () => {
  it("finds static, re-exported, side-effect, dynamic and type imports", () => {
    const source = `
import { a } from "./a.ts";
import type { B } from '../b.ts';
import {
  c,
  d,
} from "./c.ts";
export { e } from "./e.ts";
export * from "./f.ts";
import "./side.ts";
const g = await import("./g.ts");
type H = import("./h.ts").H;
import fs from "node:fs";`;
    expect(parseImports(source)).toEqual([
      { specifier: "./a.ts", typeOnly: false },
      { specifier: "../b.ts", typeOnly: true },
      { specifier: "./c.ts", typeOnly: false },
      { specifier: "./e.ts", typeOnly: false },
      { specifier: "./f.ts", typeOnly: false },
      { specifier: "node:fs", typeOnly: false },
      { specifier: "./side.ts", typeOnly: false },
      { specifier: "./g.ts", typeOnly: false },
      { specifier: "./h.ts", typeOnly: false },
    ]);
  });
});

describe("resolveImport", () => {
  const files = new Set([
    "apps/api/src/modules/workflow.ts",
    "packages/knowledge/src/types.ts",
    "apps/web/src/lib/api.ts",
    "apps/web/src/components/ui/index.tsx",
  ]);
  const exists = (path) => files.has(path);
  const resolve = (from, spec) => resolveImport(from, spec, { exists, packages });

  it("resolves relative paths with and without extensions", () => {
    expect(resolve("apps/api/src/modules/chat.ts", "./workflow.ts")).toBe("apps/api/src/modules/workflow.ts");
    expect(resolve("apps/api/src/modules/chat.ts", "./workflow")).toBe("apps/api/src/modules/workflow.ts");
    expect(resolve("apps/api/src/server.ts", "./modules/workflow.ts")).toBe("apps/api/src/modules/workflow.ts");
  });
  it("maps TypeScript ESM .js specifiers to the .ts source", () => {
    expect(resolve("packages/knowledge/src/index.ts", "./types.js")).toBe("packages/knowledge/src/types.ts");
  });
  it("resolves directory indexes, the web alias and workspace packages", () => {
    expect(resolve("apps/web/src/components/orbit.tsx", "./ui")).toBe("apps/web/src/components/ui/index.tsx");
    expect(resolve("apps/web/src/components/orbit.tsx", "@/lib/api")).toBe("apps/web/src/lib/api.ts");
    expect(resolve("packages/knowledge/src/index.ts", "@orbit/db")).toBe("packages/db/src/index.ts");
  });
  it("ignores external modules and the web alias outside the web app", () => {
    expect(resolve("apps/api/src/server.ts", "fastify")).toBeNull();
    expect(resolve("apps/api/src/server.ts", "node:fs")).toBeNull();
    expect(resolve("apps/api/src/server.ts", "@/lib/api")).toBeNull();
  });
});

describe("classify", () => {
  it("lets the longest prefix or exact file win", () => {
    expect(classify("apps/api/src/modules/chat.ts", config.zones)).toBe("platform");
    expect(classify("apps/api/src/modules/workflow.ts", config.zones)).toBe("module:marketing");
    expect(classify("apps/api/src/modules/knowledge/routes.ts", config.zones)).toBe("module:knowledge");
    expect(classify("apps/web/src/components/knowledge.tsx", config.zones)).toBe("web-module:knowledge");
    expect(classify("apps/web/src/lib/api.ts", config.zones)).toBe("web-platform");
    expect(classify("scripts/dev.ts", config.zones)).toBeNull();
  });
});

describe("repository zones", () => {
  it("gives Support its own API and web zones, not marketing's or the platform's", () => {
    const zones = JSON.parse(
      readFileSync(new URL("./boundaries.json", import.meta.url), "utf8"),
    ).zones;
    expect(classify("apps/api/src/modules/support/ai.ts", zones)).toBe("module:support");
    expect(classify("apps/web/src/modules/support/inbox.tsx", zones)).toBe("web-module:support");
    expect(classify("apps/api/src/modules/workflow.ts", zones)).toBe("module:marketing");
  });
});

describe("ruleFor", () => {
  const rule = (from, to, file = "x.ts") => ruleFor(from, to, file, config);
  it("forbids the platform, the worker and the web platform to import modules", () => {
    expect(rule("platform", "module:marketing")).toBe("platform-imports-module");
    expect(rule("worker", "module:marketing")).toBe("worker-imports-module");
    expect(rule("web-platform", "web-module:marketing")).toBe("web-platform-imports-module");
  });
  it("allows a module to use a declared dependency only through its contract", () => {
    expect(rule("module:marketing", "module:knowledge", "apps/api/src/modules/knowledge/contract.ts")).toBeNull();
    expect(rule("module:marketing", "module:knowledge", "apps/api/src/modules/knowledge/routes.ts")).toBe("module-cross-boundary");
    expect(rule("module:knowledge", "module:marketing", "apps/api/src/modules/marketing/contract.ts")).toBe("module-cross-boundary");
    expect(rule("web-module:knowledge", "web-module:marketing")).toBe("web-module-cross");
  });
  it("forbids packages to import apps and the web app to import server code", () => {
    expect(rule("package:db", "platform", "apps/api/src/shared.ts")).toBe("package-imports-app");
    expect(rule("web-module:marketing", "platform")).toBe("web-imports-server");
    expect(rule("web-platform", "package:db")).toBe("web-imports-server");
    expect(rule("web-platform", "package:schemas")).toBeNull();
  });
  it("allows modules to use the platform and packages, and composition roots anything", () => {
    expect(rule("module:marketing", "platform")).toBeNull();
    expect(rule("module:marketing", "package:db")).toBeNull();
    expect(rule("worker", "platform")).toBeNull();
    expect(rule("root:api", "module:marketing")).toBeNull();
  });
});

describe("checkBoundaries and the baseline", () => {
  const files = {
    "apps/api/src/modules/chat.ts": 'import { enqueue } from "./workflow.ts";\nimport { x } from "./missing.ts";',
    "apps/api/src/modules/workflow.ts": 'import { db } from "@orbit/db";\nimport { y } from "./chat.ts";',
    "apps/worker/src/main.ts": 'import { run } from "../../api/src/modules/workflow.ts";',
    "tools/script.ts": "export {};",
  };
  const exists = (path) => path in files || path === "packages/db/src/index.ts";
  const result = checkBoundaries(files, config, { exists, packages });

  it("reports violations, unclassified files, unresolved imports and edges", () => {
    expect(result.violations).toEqual([
      "platform-imports-module: apps/api/src/modules/chat.ts -> apps/api/src/modules/workflow.ts",
      "worker-imports-module: apps/worker/src/main.ts -> apps/api/src/modules/workflow.ts",
    ]);
    expect(result.unclassified).toEqual(["tools/script.ts"]);
    expect(result.unresolved).toEqual(["apps/api/src/modules/chat.ts -> ./missing.ts"]);
    expect(result.edges).toEqual([
      ["module:marketing -> package:db", 1],
      ["module:marketing -> platform", 1],
      ["platform -> module:marketing", 1],
      ["worker -> module:marketing", 1],
    ]);
  });

  it("fails only on violations outside the baseline and lists resolved ones", () => {
    expect(compareBaseline(result.violations, [result.violations[0], "platform-imports-module: gone.ts -> x.ts"])).toEqual({
      added: [result.violations[1]],
      resolved: ["platform-imports-module: gone.ts -> x.ts"],
    });
  });
});

describe("checkForbiddenLiterals", () => {
  const literals = {
    ...config,
    forbiddenLiterals: { "package:db": ["content", "jobs"] },
  };

  it("flags a forbidden string literal in its zone, in any quote style", () => {
    expect(
      checkForbiddenLiterals(
        {
          "packages/db/src/a.ts": 'const kinds = ["content"];',
          "packages/db/src/b.ts": "where({ kind: 'jobs' }); const t = `content`;",
        },
        literals,
      ),
    ).toEqual([
      'forbidden-literal: packages/db/src/a.ts -> "content"',
      'forbidden-literal: packages/db/src/b.ts -> "content"',
      'forbidden-literal: packages/db/src/b.ts -> "jobs"',
    ]);
  });

  it("ignores the word outside string literals and in other zones", () => {
    expect(
      checkForbiddenLiterals(
        {
          "packages/db/src/a.ts": 'const contentIds = []; const s = "content-type";',
          "apps/api/src/modules/chat.ts": 'const kind = "content";',
        },
        literals,
      ),
    ).toEqual([]);
  });
});
