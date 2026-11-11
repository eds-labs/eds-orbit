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
      .toBe("Applies to projects that follow the standard (1) and to projects without own AI settings (2); projects with their own choice (3) keep the values they set. Saving changes the route version of every project of this organization (6): running AI work there stops before its next paid call.");
    expect(affectedText("affectedOrgCatalog", { total: 6 }, "de")).toBe(
      "Preise und Schalter hier gelten für jedes Projekt dieser Organisation (6), das keinen eigenen Preis festlegt.",
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
    expect(org).toContain("Applies to projects that follow the standard (1) and to projects without own AI settings (2); projects with their own choice (3)");
    expect(org).toContain("route version of every project of this organization (6)");
    const system = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="profile" total={9} locale="de" />,
    );
    expect(system).toContain("Routen-Version jedes Projekts (9) und jedes persönlichen Bereichs");
    const prices = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="catalog" total={9} locale="en" />,
    );
    expect(prices).toContain("that sets no price of its own (projects: 9).");
  });

  it("adds the unreadable projects to the organization's notices, whose counts are then too low", () => {
    for (const kind of ["profile", "catalog"] as const) {
      const html = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind={kind} counts={counts} unreadable={2} locale="en" />,
      );
      expect(html).toContain(". Projects that could not be read and are missing from this list: 2.");
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

  it("says only the route version change while the organization's standard does not apply", () => {
    for (const locale of ["en", "de"] as const) {
      const off = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind="profile" counts={counts} standardApplies={false} locale={locale} />,
      );
      const on = renderToStaticMarkup(
        <AffectedProjectsNotice scope="organization" kind="profile" counts={counts} standardApplies locale={locale} />,
      );
      expect(off).toContain(affectedText("affectedOrgRouteOnly", { total: 6 }, locale));
      expect(off).not.toContain(affectedText("affectedOrgProfile", counts, locale));
      expect(on).toContain(affectedText("affectedOrgProfile", counts, locale));
    }
    const off = renderToStaticMarkup(
      <AffectedProjectsNotice scope="organization" kind="profile" counts={counts} standardApplies={false} unreadable={1} locale="en" />,
    );
    expect(off).toContain("Saving changes the route version of every project of this organization (6)");
    expect(off).not.toContain("follow the standard");
    expect(off).toContain(". Projects that could not be read and are missing from this list: 1.");
  });

  it("says only the route version change for the system's standard while standard models are off", () => {
    const off = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="profile" total={9} standardApplies={false} locale="en" />,
    );
    expect(off).toContain(
      "Saving changes the route version of every project (9) and of every personal space: running AI work stops before its next paid call.",
    );
    expect(off).not.toContain("Applies to every project");
    const on = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="profile" total={9} standardApplies locale="en" />,
    );
    expect(on).toContain("Applies to every project whose organization and own settings leave a value open.");
    // Without the prop (the advanced section) the full profile notice stays.
    const advanced = renderToStaticMarkup(
      <AffectedProjectsNotice scope="system" kind="profile" total={9} locale="de" />,
    );
    expect(advanced).toContain("Gilt für jedes Projekt");
  });

  it("fills every placeholder of every notice in both languages", () => {
    const notices = [];
    for (const locale of ["en", "de"] as const) {
      for (const kind of ["profile", "catalog"] as const) {
        for (const standardApplies of [true, false]) {
          for (const unreadable of [0, 3])
            notices.push(
              <AffectedProjectsNotice scope="organization" kind={kind} counts={counts} standardApplies={standardApplies} unreadable={unreadable} locale={locale} />,
            );
          notices.push(
            <AffectedProjectsNotice scope="system" kind={kind} total={9} standardApplies={standardApplies} locale={locale} />,
          );
        }
      }
    }
    expect(notices).toHaveLength(24);
    for (const notice of notices) {
      const html = renderToStaticMarkup(notice);
      expect(html).toMatch(/\d/);
      expect(html).not.toContain("{");
      // Count-neutral (P4-R11): a count never stands before a plural noun.
      expect(html).not.toMatch(/\d+ (projects|Projekte)\b/);
    }
  });
});
