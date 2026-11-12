import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { manageHref } from "../routes";
import {
  affectedCounts,
  OrganizationAiProjectsView,
  type OrganizationAiProjects,
} from "./organization-projects";

const entry = (
  projectId: string,
  name: string,
  over: Partial<OrganizationAiProjects["projects"][number]> = {},
): OrganizationAiProjects["projects"][number] => ({
  projectId,
  name,
  routingMode: "organization",
  ownKeys: { openai: false, image: false, anthropic: false },
  overrides: { models: false, routes: false, prices: false, providerBudgets: false },
  spendingAuthority: "none",
  ...over,
});

const fixture: OrganizationAiProjects = {
  routingApplied: true,
  unreadable: 0,
  projects: [
    entry("p1", "Alpha", { spendingAuthority: "active" }),
    entry("p2", "Beta", { routingMode: "unsaved" }),
    entry("p3", "Gamma", {
      routingMode: "preset",
      ownKeys: { openai: true, image: false, anthropic: true },
      spendingAuthority: "expired",
    }),
    entry("p4", "Delta", {
      routingMode: "custom",
      overrides: { models: true, routes: false, prices: true, providerBudgets: true },
      spendingAuthority: "invalid",
    }),
  ],
};

const projectHref = (id: string) =>
  manageHref({ kind: "project", projectId: id }, "ai");
const view = (data: OrganizationAiProjects, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <OrganizationAiProjectsView data={data} locale={locale} projectHref={projectHref} />,
  );

describe("organization AI projects", () => {
  it("counts who follows, who has no settings and who chose their own", () => {
    expect(affectedCounts(fixture)).toEqual({ total: 4, following: 1, unsaved: 1, own: 2 });
    // A mode this build does not know counts only in the total.
    const unknown = {
      ...fixture,
      projects: [entry("p9", "New", { routingMode: "future" as never })],
    };
    expect(affectedCounts(unknown)).toEqual({ total: 1, following: 0, unsaved: 0, own: 0 });
  });

  it("lists each project with its choice, keys, overrides and authority, linked to its AI area", () => {
    const html = view(fixture);
    expect(projectHref("p1")).toBe("/manage/p/p1/ai");
    for (const id of ["p1", "p2", "p3", "p4"])
      expect(html).toContain(`href="${projectHref(id)}"`);
    for (const head of ["Project", "Model choice", "Own keys", "Set by the project", "Spending authority"])
      expect(html).toContain(`<th scope="col">${head}</th>`);
    const row = (name: string) => {
      const start = html.indexOf(`>${name}</a>`);
      return html.slice(start, html.indexOf("</tr>", start));
    };
    expect(row("Alpha")).toContain("Organization standard");
    expect(row("Alpha")).toContain("active");
    expect(row("Beta")).toContain("No own settings");
    expect(row("Beta")).toContain("not set");
    expect(row("Gamma")).toContain("Own level");
    expect(row("Gamma")).toContain("OpenAI key, Claude key");
    expect(row("Gamma")).toContain("expired");
    expect(row("Delta")).toContain("Own settings");
    expect(row("Delta")).toContain("models, prices, provider budgets");
    expect(row("Delta")).toContain("invalid");
    // Nothing set by the project and no own key read as "none".
    expect(row("Alpha").match(/>none</g)).toHaveLength(2);
    expect(html).not.toContain("could not be read");
    const de = view(fixture, "de");
    expect(de).toContain("Organisationsstandard");
    expect(de).toContain("Ausgabenfreigabe");
  });

  it("shows a mode or an authority this build does not know as it is", () => {
    const html = view({
      ...fixture,
      projects: [
        entry("p9", "New", {
          routingMode: "future" as never,
          spendingAuthority: "paused" as never,
        }),
      ],
    });
    expect(html).toContain("future");
    expect(html).toContain("paused");
  });

  it("says when the organization has no projects", () => {
    const html = view({ routingApplied: true, unreadable: 0, projects: [] });
    expect(html).toContain("This organization has no projects yet.");
    expect(html).not.toContain("<table");
  });

  it("says how many projects could not be read", () => {
    const html = view({ ...fixture, unreadable: 2 });
    expect(html).toContain("Projects that could not be read and are missing from this list: 2.");
    expect(html.indexOf("could not be read")).toBeLessThan(html.indexOf("<table"));
    const empty = view({ routingApplied: true, unreadable: 1, projects: [] }, "de");
    expect(empty).toContain("Projekte, die nicht gelesen werden konnten und in dieser Liste fehlen: 1.");
  });

  it("says the choices are saved ones while standard models are off", () => {
    const off = view({ ...fixture, routingApplied: false });
    expect(off).toContain("Standard models and presets are not switched on for this installation");
    expect(off.indexOf("not switched on")).toBeLessThan(off.indexOf("<table"));
    expect(view(fixture)).not.toContain("not switched on");
  });
});
