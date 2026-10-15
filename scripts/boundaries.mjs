// Import-boundary check for the modular Orbit platform (ADR 0009, AD-13).
// Classifies every source file into a zone (platform, module, package,
// worker, web platform, web module, composition root) by the mapping in
// scripts/boundaries.json and reports imports that cross a forbidden edge.
// No dependencies: imports are found with regular expressions and resolved
// against the file system.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const SOURCE = /\.(ts|tsx|mjs|js)$/;
const TEST = /(\.test\.(ts|tsx|mjs)$|\/tests\/|\.spec\.ts$)/;
const SKIP_DIRS = new Set(["node_modules", ".next", "generated", "design"]);
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

/** Every import specifier in a source text, with whether it is type-only. */
export function parseImports(source) {
  const found = [];
  const add = (specifier, typeOnly) => found.push({ specifier, typeOnly });
  // import … from "x", export … from "x" (also across lines).
  for (const m of source.matchAll(
    /\b(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g,
  ))
    add(m[3], Boolean(m[2]));
  // Side-effect imports: import "x".
  for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g))
    add(m[1], false);
  // Dynamic imports and import types: import("x").
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g))
    add(m[1], false);
  return found;
}

/**
 * The repository-relative file an import points to, or null for external
 * modules. `packages` maps workspace package names to their entry file.
 */
export function resolveImport(fromFile, specifier, { exists, packages }) {
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../"))
    base = normalize(join(dirname(fromFile), specifier));
  else if (specifier.startsWith("@/") && fromFile.startsWith("apps/web/"))
    base = join("apps/web/src", specifier.slice(2));
  else if (packages[specifier]) return packages[specifier];
  else return null;
  if (exists(base) && SOURCE.test(base)) return base;
  // TypeScript ESM style: "./types.js" names the source file "./types.ts".
  const bare = base.replace(/\.(js|mjs)$/, "");
  if (bare !== base)
    for (const ext of EXTENSIONS) if (exists(bare + ext)) return bare + ext;
  for (const ext of EXTENSIONS) if (exists(base + ext)) return base + ext;
  for (const ext of EXTENSIONS)
    if (exists(join(base, "index" + ext))) return join(base, "index" + ext);
  return null;
}

/** The zone of a file: the longest matching path prefix (or exact file) wins. */
export function classify(file, zones) {
  let best = null;
  for (const [zone, paths] of Object.entries(zones))
    for (const path of paths)
      if (
        (path.endsWith("/") ? file.startsWith(path) : file === path) &&
        (!best || path.length > best.path.length)
      )
        best = { zone, path };
  return best?.zone ?? null;
}

const kindOf = (zone) => zone?.split(":")[0] ?? null;
const idOf = (zone) => zone?.split(":")[1] ?? null;

/**
 * The rule an import breaks, or null. Rules (plans/orbit-modularization/02 §3):
 * platform-imports-module, module-cross-boundary, package-imports-app,
 * worker-imports-module, web-platform-imports-module, web-module-cross,
 * web-imports-server.
 */
export function ruleFor(fromZone, toZone, toFile, config) {
  const from = kindOf(fromZone),
    to = kindOf(toZone);
  if (!from || !to || from === "root") return null;
  if (from === "package" && toFile.startsWith("apps/"))
    return "package-imports-app";
  if (from === "platform" && to === "module") return "platform-imports-module";
  if (from === "worker" && to === "module") return "worker-imports-module";
  if (from === "module" && to === "module" && fromZone !== toZone) {
    const allowed = config.dependencies?.[fromZone] ?? [];
    return allowed.includes(toZone) && toFile.endsWith("/contract.ts")
      ? null
      : "module-cross-boundary";
  }
  if (from === "web-platform" && to === "web-module")
    return "web-platform-imports-module";
  if (from === "web-module" && to === "web-module" && fromZone !== toZone)
    return "web-module-cross";
  // The web app never reaches the database or server code (ADR 0001).
  if (
    (from === "web-platform" || from === "web-module") &&
    (["platform", "module", "worker", "root"].includes(to) ||
      (config.serverPackages ?? []).includes(toZone))
  )
    return "web-imports-server";
  return null;
}

/** Repository-relative source files below the given roots, tests excluded. */
export function sourceFiles(root, dirs) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE.test(path) && !TEST.test(path)) files.push(path);
    }
  };
  for (const dir of dirs) if (existsSync(join(root, dir))) walk(dir);
  return files.sort();
}

/** Workspace package names mapped to their entry file. */
export function workspacePackages(root) {
  const map = {};
  for (const name of readdirSync(join(root, "packages"))) {
    const manifest = join(root, "packages", name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
    if (pkg.name && entry) map[pkg.name] = normalize(join("packages", name, entry));
  }
  return map;
}

// Internal imports of non-code files (styles, data, images) are not edges.
const ASSET = /\.(css|json|svg|png|jpe?g|webp|woff2?)$/;
const internal = (specifier) =>
  specifier.startsWith("./") ||
  specifier.startsWith("../") ||
  specifier.startsWith("@/") ||
  specifier.startsWith("@orbit/");

/**
 * Checks `files` ({path: source}). Returns sorted violation ids
 * ("rule: from -> to"), files no zone claims, internal imports the resolver
 * could not follow (the check would be blind to them) and the zone edges.
 */
export function checkBoundaries(files, config, { exists, packages }) {
  const violations = new Set();
  const unclassified = [];
  const unresolved = [];
  const edges = new Map();
  for (const [file, source] of Object.entries(files)) {
    const fromZone = classify(file, config.zones);
    if (!fromZone) {
      unclassified.push(file);
      continue;
    }
    for (const { specifier } of parseImports(source)) {
      const target = resolveImport(file, specifier, { exists, packages });
      if (!target) {
        if (internal(specifier) && !ASSET.test(specifier))
          unresolved.push(`${file} -> ${specifier}`);
        continue;
      }
      const toZone = classify(target, config.zones);
      if (!toZone || toZone === fromZone) continue;
      const edge = `${fromZone} -> ${toZone}`;
      edges.set(edge, (edges.get(edge) ?? 0) + 1);
      const rule = ruleFor(fromZone, toZone, target, config);
      if (rule) violations.add(`${rule}: ${file} -> ${target}`);
    }
  }
  return {
    violations: [...violations].sort(),
    unclassified: unclassified.sort(),
    unresolved: unresolved.sort(),
    edges: [...edges.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

/**
 * String literals a zone must not contain (`config.forbiddenLiterals`), as
 * sorted ids "forbidden-literal: file -> \"literal\"". Keeps the knowledge
 * engine from naming another module's entity kinds (WP3.1).
 */
export function checkForbiddenLiterals(files, config) {
  const found = [];
  for (const [file, source] of Object.entries(files)) {
    const zone = classify(file, config.zones);
    for (const literal of config.forbiddenLiterals?.[zone] ?? []) {
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(["'\`])${escaped}\\1`).test(source))
        found.push(`forbidden-literal: ${file} -> "${literal}"`);
    }
  }
  return found.sort();
}

/** New violations (not in the baseline) and resolved ones (baseline only). */
export function compareBaseline(violations, baseline) {
  const known = new Set(baseline);
  const current = new Set(violations);
  return {
    added: violations.filter((v) => !known.has(v)),
    resolved: baseline.filter((v) => !current.has(v)),
  };
}

/** Runs the check on the repository at `root`. */
export function checkRepository(root) {
  const config = JSON.parse(
    readFileSync(join(root, "scripts/boundaries.json"), "utf8"),
  );
  const files = Object.fromEntries(
    sourceFiles(root, config.roots).map((path) => [
      path,
      readFileSync(join(root, path), "utf8"),
    ]),
  );
  const exists = (path) => {
    try {
      return statSync(join(root, path)).isFile();
    } catch {
      return false;
    }
  };
  const imports = checkBoundaries(files, config, {
    exists,
    packages: workspacePackages(root),
  });
  const result = {
    ...imports,
    violations: [
      ...imports.violations,
      ...checkForbiddenLiterals(files, config),
    ].sort(),
  };
  return { config, ...result, ...compareBaseline(result.violations, config.baseline) };
}

