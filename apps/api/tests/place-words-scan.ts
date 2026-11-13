import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// The scanner behind center-links.test.ts (kept out of the test file so the
// web test can mirror it without importing a test). A text that sends the
// reader to a settings place names it as the center shows it
// ("Administration & settings → AI → Budget"), not by an old page.
// An identical copy lives in apps/web/src/platform/settings-center/place-words.ts.

const CENTER_NAMES = ["Administration & settings", "Verwaltung & Einstellungen"];

/** Old places named with an arrow: "Settings → AI", "Konto → …". */
const ARROW = /(Settings|Einstellungen|Account|Konto|Administration)\s*(→|->)\s/g;
/** The comma form: "Settings, Support", "Einstellungen, Finanzkonten". */
const COMMA = /(Settings|Einstellungen), [A-ZÄÖÜ]/g;
/** The retired Connectors page. */
const CONNECTORS = /\b(?:under|unter|in) (?:the )?(?:Connectors|Konnektoren)\b/gi;
/** A bare "in the settings" with no center name anywhere in the sentence. */
const BARE =
  /\b(?:in|under|unter|im|in den|in the) (?:the |den )?(?:project |organization |Projekt|Organisations)?-?(?:settings|Einstellungen)\b|\b(?:project|organization) settings\b|\b(?:Projekt|Organisations)einstellungen\b/gi;

/** Literals that are labels of links or names of real module pages. */
const ALLOWED: RegExp[] = [
  /^(Open )?(organization|project) settings$/i,
  /^(Organisations|Projekt)einstellungen öffnen$/,
];

/** Every string literal, template chunk and JSX text of a source file. */
export function literalsOf(source: string, name: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Whether the match at `index` is part of a path that starts with the
 * center's name: the name ends before it (or the match is the German name's
 * own last word) with no sentence break between.
 */
function startsWithCenter(text: string, index: number, word: string): boolean {
  if ((text.slice(0, index) + word).endsWith("Verwaltung & Einstellungen"))
    return true;
  for (const name of CENTER_NAMES) {
    const at = text.lastIndexOf(name, index);
    if (at === -1) continue;
    if (!/[.;)“”"]/.test(text.slice(at + name.length, index))) return true;
  }
  return false;
}

/** The reasons a literal names an old place; empty when it is clean. */
export function oldPlaces(text: string): string[] {
  if (ALLOWED.some((re) => re.test(text.trim()))) return [];
  const bad: string[] = [];
  for (const m of text.matchAll(ARROW))
    if (!startsWithCenter(text, m.index, m[1])) bad.push(text);
  for (const m of text.matchAll(COMMA))
    if (!startsWithCenter(text, m.index, m[1])) bad.push(text);
  if (CONNECTORS.test(text)) bad.push(text);
  CONNECTORS.lastIndex = 0;
  if (!CENTER_NAMES.some((n) => text.includes(n)) && BARE.test(text))
    bad.push(text);
  BARE.lastIndex = 0;
  return [...new Set(bad)];
}

/** Files that describe somebody else's console or are the center itself. */
const SKIP = [
  "modules/ads/accounts/providers.ts",
  "modules/social/accounts/providers.ts",
];

/** Every non-test source file below `root`, relative to it. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(relative(root, path));
      }
    }
  };
  walk(root);
  return out.filter((f) => !SKIP.includes(f)).sort();
}

/** The flagged literals of the whole tree, as "file: text". */
export function treeProblems(root: string): string[] {
  return sourceFiles(root).flatMap((file) =>
    literalsOf(readFileSync(join(root, file), "utf8"), file)
      .flatMap(oldPlaces)
      .map((text) => `${file}: ${text}`),
  );
}
