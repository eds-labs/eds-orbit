import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = process.cwd();
const includedRoots = [
  ".github",
  "apps",
  "evals",
  "infra",
  "packages",
  "scripts",
  "tests",
];
const rootFiles = [
  ".dockerignore",
  ".env.example",
  ".nvmrc",
  "AGENTS.md",
  "README.md",
  "VERSION",
  "docker-compose.yml",
  "package.json",
  "playwright.config.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
];
const ignored = new Set([
  ".DS_Store",
  ".next",
  ".runtime",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const paths = [];
function visit(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (!ignored.has(name)) visit(resolve(path, name));
    }
    return;
  }
  paths.push(relative(root, path).replaceAll("\\", "/"));
}
for (const directory of includedRoots) visit(resolve(root, directory));
for (const file of rootFiles) visit(resolve(root, file));
paths.sort();
const files = paths.map((path) => ({
  path,
  sha256: createHash("sha256")
    .update(readFileSync(resolve(root, path)))
    .digest("hex"),
}));
const sourceSetSha256 = createHash("sha256")
  .update(files.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join(""))
  .digest("hex");
const manifest = {
  generatedAt: new Date().toISOString(),
  version: "0.1.0-rc.1",
  scope:
    "Application, tests, evals, runtime infrastructure, setup and CI sources; excludes documentation, runtime credentials, dependencies and generated build output.",
  aggregateAlgorithm: "sha256(path + NUL + fileSha256 + LF), sorted by path",
  files,
  sourceSetSha256,
};
writeFileSync(
  resolve(root, "docs/evidence/source-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `Recorded ${files.length} source files with aggregate ${sourceSetSha256}.`,
);
