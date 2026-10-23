import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0013: system administration manages metadata, never project content.
// Its code reaches the database only through the control-plane client
// (authDb) and never opens a project-scoped business transaction or imports
// a product module.
const dir = new URL("../src/platform/administration/", import.meta.url)
  .pathname;

describe("administration boundary (metadata only)", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("covers the administration service files", () => {
    expect(files.length).toBeGreaterThan(5);
  });
  for (const file of files)
    it(`${file} uses no business-data client or module`, () => {
      const source = readFileSync(join(dir, file), "utf8");
      const imports = [
        ...source.matchAll(/import\s+([^;]*?)\s+from\s+"([^"]+)"/g),
      ];
      for (const [, names, path] of imports) {
        if (path!.endsWith("packages/db/src/index.ts"))
          expect(names).not.toMatch(/\b(db|scoped|userScoped)\b/);
        // Product modules live in src/modules; the platform module registry
        // (platform/modules) is allowed.
        expect(path).not.toMatch(/^(\.\.\/){2,}modules\//);
      }
      expect(source).not.toMatch(/\bscoped\(/);
    });
});
