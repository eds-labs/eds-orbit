import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AffectedProjectsNotice,
  affectedText,
  OrganizationAffected,
  SystemAffected,
} from "./affected-projects";

const counts = { total: 6, following: 1, unsaved: 2, own: 3 };

describe("affected projects", () => {
  it("fills the counts into the organization's profile notice", () => {
    expect(affectedText("affectedOrgProfile", { following: 1, unsaved: 2, own: 3, total: 6 }, "en"))
      .toBe("Applies to 1 projects that follow the standard and 2 without own AI settings; 3 projects with their own choice keep the values they set. Saving changes the route version of all 6 projects of this organization: running AI work there stops before its next paid call.");
    expect(affectedText("affectedOrgCatalog", { total: 6 }, "de")).toBe(
      "Preise und Schalter hier gelten für alle 6 Projekte dieser Organisation, sofern ein Projekt keinen eigenen Preis festlegt.",
    );
  });

  it("does not claim a route version change for prices", () => {
    for (const locale of ["en", "de"] as const) {
      for (const key of ["affectedOrgCatalog", "affectedSystemCatalog"] as const) {
        const text = affectedText(key, { total: 6 }, locale);
        expect(text).not.toContain("route version");
        expect(text).not.toContain("Routen-Version");
      }
      const org = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind="catalog" counts={counts} locale={locale} />,
      );
      const system = renderToStaticMarkup(
        <AffectedProjectsNotice scope="system" kind="catalog" total={6} locale={locale} />,
      );
      for (const html of [org, system]) {
        expect(html).not.toContain("route version");
        expect(html).not.toContain("Routen-Version");
      }
    }
  });

  it("names the route version change for a profile in both scopes", () => {
    const org = renderToStaticMarkup(
      <AffectedProjectsNotice scope="organization" kind="profile" counts={counts} locale="en" />,
    );
    expect(org).toContain("Applies to 1 projects that follow the standard and 2 without own AI settings; 3 projects");
    expect(org).toContain("route version of all 6 projects of this organization");
    const system = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="profile" total={9} locale="de" />,
    );
    expect(system).toContain("Routen-Version aller 9 Projekte und jedes persönlichen Bereichs");
    const prices = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="catalog" total={9} locale="en" />,
    );
    expect(prices).toContain("that sets no price of its own (9 projects).");
  });

  it("adds the unreadable projects to the organization's notices, whose counts are then too low", () => {
    for (const kind of ["profile", "catalog"] as const) {
      const html = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind={kind} counts={counts} unreadable={2} locale="en" />,
      );
      expect(html).toContain(". 2 projects could not be read and are missing from this list.");
      const clean = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind={kind} counts={counts} unreadable={0} locale="en" />,
      );
      expect(clean).not.toContain("could not be read");
    }
  });

  it("renders nothing while the counts load", () => {
    expect(renderToStaticMarkup(<OrganizationAffected organizationId="w1" kind="profile" locale="en" />)).toBe("");
    expect(renderToStaticMarkup(<SystemAffected kind="catalog" locale="en" />)).toBe("");
  });
});
