import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Texts that send the reader to a settings place name it as the center
// shows it ("Administration & settings → AI → Budget"), not by the old page
// ("Settings → AI & budget"). Only string literals count: a module page that
// is really called "Settings" ("Support → Settings") has no old-place arrow
// before it, and a center section such as "Marketing settings" has no arrow.
const FILES = [
  "lib/exception-text.ts",
  "lib/budget-refusals.ts",
  "lib/readiness-text.ts",
  "lib/i18n.ts",
  "modules/knowledge/workspace-parts.tsx",
  "modules/knowledge/add-flow.tsx",
  "modules/marketing/advanced.tsx",
  "modules/finance/labels.ts",
  "components/telegram-connection.tsx",
  "components/signal-settings.tsx",
];

const OLD_PLACE = /(Settings|Einstellungen|Account|Konto|Administration) → /g;

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

/** The old-place paths of a literal that do not follow the center's name. */
export function oldPlaces(text: string): string[] {
  const bad: string[] = [];
  for (const match of text.matchAll(OLD_PLACE)) {
    // "Administration & settings → …" has a lower-case "settings" and never
    // matches; the German name ends in the word that matches, and later
    // steps ("Mein Konto → …") follow the name.
    const before = text.slice(0, match.index);
    const named =
      before.includes("Administration & settings") ||
      before.includes("Verwaltung & Einstellungen") ||
      (before + match[1]).endsWith("Verwaltung & Einstellungen");
    if (!named) bad.push(text);
  }
  return bad;
}

describe("texts name settings places as the center shows them", () => {
  for (const path of FILES) {
    it(`${path} has no old place`, () => {
      const source = readFileSync(
        new URL(`../../${path}`, import.meta.url),
        "utf8",
      );
      expect(literalsOf(source, path).flatMap(oldPlaces)).toEqual([]);
    });
  }

  it("lets the center's own names and module pages through", () => {
    expect(oldPlaces("Administration & settings → AI → Budget")).toEqual([]);
    expect(oldPlaces("Verwaltung & Einstellungen → KI → Budget")).toEqual([]);
    expect(oldPlaces("Open Support → Settings")).toEqual([]);
    expect(oldPlaces("Marketing settings")).toEqual([]);
    expect(oldPlaces("Settings → AI & budget")).toHaveLength(1);
    expect(
      oldPlaces("Verwaltung & Einstellungen → Mein Konto → Assistent"),
    ).toEqual([]);
    expect(oldPlaces("Einstellungen → KI")).toHaveLength(1);
  });
});
