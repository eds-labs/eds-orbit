import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleRegistry, modules } from "../src/modules/registry.ts";

/** Repository-relative TypeScript sources below `dir`, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/**
 * Entity kinds the code reads or writes: literal kind arguments of the entity
 * helpers, string constants passed to them, and kind filters of raw
 * tx.entity queries.
 */
function usedKinds() {
  const kinds = new Set<string>();
  const files = [
    ...sources("apps/api/src"),
    ...sources("apps/worker/src"),
    ...sources("packages/knowledge/src"),
  ];
  // Exported kind constants, such as CONNECTION_KIND, are used elsewhere.
  const exported = new Map(
    files.flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /\bexport const ([A-Z_]+) = "([a-z_]+)";/g,
        ),
      ].map((m) => [m[1]!, m[2]!] as const),
    ),
  );
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const constants = new Map([
      ...exported,
      ...[...text.matchAll(/\bconst ([A-Z_]+) = "([a-z_]+)";/g)].map(
        (m) => [m[1]!, m[2]!] as const,
      ),
    ]);
    for (const m of text.matchAll(
      /\b(?:create|list|entity)\(\s*\w+\s*,\s*[^,()]+,\s*("([a-z_]+)"|([A-Z_]+))\s*[,)]/g,
    ))
      kinds.add(m[2] ?? constants.get(m[3]!) ?? `<unknown constant ${m[3]}>`);
    for (const query of text.matchAll(
      /\.entity\.(?:create|findFirst|findFirstOrThrow|findMany|count|updateMany|deleteMany)\(\s*\{[\s\S]{0,400}?\bkind:\s*(?:"([a-z_]+)"|\{\s*in:\s*\[([^\]]+)\])/g,
    )) {
      if (query[1]) kinds.add(query[1]);
      for (const k of (query[2] ?? "").matchAll(/"([a-z_]+)"/g))
        kinds.add(k[1]!);
    }
  }
  return kinds;
}

/** Table names of the Prisma schema (the @@map name where set). */
function schemaTables() {
  const schema = readFileSync("packages/db/prisma/schema.prisma", "utf8");
  return [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
    (m) => /@@map\("([^"]+)"\)/.exec(m[2]!)?.[1] ?? m[1]!,
  );
}

describe("static module registry", () => {
  const registry = moduleRegistry();

  it("validates and orders marketing after knowledge", () => {
    expect(modules.map((m) => m.id)).toEqual(["knowledge", "marketing"]);
    expect(registry.order).toEqual(["knowledge", "marketing"]);
  });

  it("gives every entity kind the code uses an owner", () => {
    const unowned = [...usedKinds()]
      .filter((kind) => !registry.kindOwner.has(kind))
      .sort();
    expect(unowned).toEqual([]);
  });

  it("declares no kind the code never uses", () => {
    const used = usedKinds();
    expect(
      [...registry.kindOwner.keys()].filter((kind) => !used.has(kind)).sort(),
    ).toEqual([]);
  });

  it("gives every table of the schema an owner, Prisma's journal included", () => {
    const tables = [...schemaTables(), "_prisma_migrations"].sort();
    expect([...registry.tableOwner.keys()].sort()).toEqual(tables);
  });
});
