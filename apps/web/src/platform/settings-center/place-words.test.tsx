import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { oldPlaces, treeProblems } from "../../../../../scripts/place-words-scan";

// Every text of the web app that sends the reader to a settings place names
// it as the center shows it. The scan covers the whole source tree (scanner:
// scripts/place-words-scan.ts, shared with the API test); the two Meta provider files describe Meta's own console
// and are skipped there.
describe("texts name settings places as the center shows them", () => {
  it("finds no old place in the web source", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    expect(treeProblems(root)).toEqual([]);
  });

  it("lets the center's own names, module pages and link labels through", () => {
    expect(oldPlaces("Administration & settings → AI → Budget")).toEqual([]);
    expect(oldPlaces("Verwaltung & Einstellungen → KI → Budget")).toEqual([]);
    expect(
      oldPlaces("Verwaltung & Einstellungen → Mein Konto → Assistent"),
    ).toEqual([]);
    expect(oldPlaces("Open Support → Settings")).toEqual([]);
    expect(oldPlaces("Marketing settings")).toEqual([]);
    expect(oldPlaces("Open organization settings")).toEqual([]);
    expect(oldPlaces("Organisationseinstellungen öffnen")).toEqual([]);
    expect(oldPlaces("Check it in Administration & settings → Integrations.")).toEqual([]);
    expect(oldPlaces("Prüfe sie unter Verwaltung & Einstellungen → KI.")).toEqual([]);
    expect(
      oldPlaces("Set it in the project, Administration & settings → AI"),
    ).toEqual([]);
  });

  it("flags the forms of the old places", () => {
    for (const text of [
      "Settings → AI & budget",
      "Einstellungen → KI",
      "Orbit → Settings → Integrations → Google Drive",
      // The name before an earlier sentence does not cover a later path.
      "See Administration & settings. Then Settings → AI.",
      "Administration → Integrationen",
      "Settings, Support",
      "Einstellungen, Finanzkonten",
      "(Settings, Financial accounts)",
      "Integrations are managed under Connectors.",
      "Check it in the organization settings.",
      "Prüfe die Kosten in den Einstellungen.",
      "Switched off in the project settings.",
      "Add one in the settings.",
      // Only the two exact link labels pass, not a sentence around them.
      "Open organization settings to change it.",
      "The GitHub App connection is invalid. Check it in the administration.",
      "Die Verbindung ist ungültig. Prüfe sie in der Administration.",
      // The center's name before an earlier sentence does not cover a later
      // bare place.
      "See Administration & settings. Then check the project settings.",
    ])
      expect(oldPlaces(text), text).not.toEqual([]);
  });
});
