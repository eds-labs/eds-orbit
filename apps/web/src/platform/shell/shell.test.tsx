import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels } from "@/lib/i18n";
import { NotFound } from "./not-found";
import { OrganizationPicker, ProjectPicker } from "./pickers";

// The project home has its own tests (home.test.tsx).
const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [
    { id: "w1", name: "Org one", role: "owner" },
    { id: "w2", name: "Org two", role: "viewer" },
  ],
  projects: [
    project,
    { ...project, id: "p2", workspaceId: "w2", name: "Other", role: "viewer" },
  ],
};

describe("Pickers", () => {
  const t = (k: keyof typeof labels.en) => labels.en[k];
  it("lists organizations with their project counts", () => {
    const html = renderToStaticMarkup(
      <OrganizationPicker identity={identity} t={t} />,
    );
    expect(html).toContain('href="/o/w1"');
    expect(html).toContain('href="/o/w2"');
    expect(html).toContain("Projects: 1");
  });

  it("lists the organization's projects and lets owners create one", () => {
    const create = { onSubmit: async () => {}, pending: false, error: null };
    const owner = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="w1"
        t={t}
        create={create}
      />,
    );
    expect(owner).toContain('href="/p/p1"');
    expect(owner).not.toContain('href="/p/p2"');
    expect(owner).toContain("New project");
    const viewer = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="w2"
        t={t}
        create={create}
      />,
    );
    expect(viewer).toContain('href="/p/p2"');
    expect(viewer).not.toContain("New project");
    const unknown = renderToStaticMarkup(
      <ProjectPicker
        identity={identity}
        organizationId="nope"
        t={t}
        create={create}
      />,
    );
    expect(unknown).toContain("Page not found");
  });

  it("says why a project cannot be opened", () => {
    const de = (k: keyof typeof labels.de) => labels.de[k];
    expect(renderToStaticMarkup(<NotFound t={de} project />)).toContain(
      "Projekt nicht verfügbar",
    );
  });
});
