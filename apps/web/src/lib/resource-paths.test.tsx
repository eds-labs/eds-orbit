import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// useResource and api() prefix "/api" themselves. A path that already starts
// with "/api/" is requested as "/api/api/…", answers 404 and silently renders
// as empty (the customer context integrations showed "not configured").
const root = "apps/web/src";
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });

describe("resource paths", () => {
  it("never pass a path with the /api prefix to useResource", () => {
    const offenders = files(root).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /useResource(?:<[^()]*?>)?\(([^;]*?)\)/gs,
        ),
      ]
        .filter((call) => /[`"']\/api\//.test(call[1]!))
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });
});
