import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { WorkspaceContext } from "@/components/workspace-context";
import {
  PublicKeysView,
  publicKeyText,
  revokeQuestion,
  type PublicKeyItem,
} from "@/components/public-keys";
import { ProjectAdministration } from "@/components/project-administration";
import { resolveSection, visibleSections } from "../registry";
import type { ManageScope } from "../types";
import { projectSections } from "./project";
import { PublicAccessSection } from "./public-access";

const key = (over: Partial<PublicKeyItem> = {}): PublicKeyItem => ({
  id: "k1",
  moduleId: "support",
  publicKey: "pk_abc",
  allowedOrigins: ["https://www.example.com"],
  createdAt: "2026-11-01T10:00:00Z",
  revokedAt: null,
  usedBy: null,
  ...over,
});

const identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  projects: [],
  workspaces: [],
} as Identity;

const inWorkspace = (isOwner: boolean, node: React.ReactNode) =>
  renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project: { id: "p1", name: "Alpha" } as unknown as Project,
        identity,
        locale: "en",
        t: (k: string) => k,
        canEdit: true,
        isOwner,
        revision: 0,
        refresh: () => {},
        href: (path: string) => path,
      }}
    >
      {node}
    </WorkspaceContext.Provider>,
  );

const sectionProps = {
  scope: { kind: "project", projectId: "p1" } as ManageScope,
  locale: "en" as const,
  identity,
  hrefOf: () => "",
};

describe("public keys list", () => {
  it("names the inbox that uses a key and warns before revoking it", () => {
    const used = key({ usedBy: { moduleId: "support", label: "Help desk" } });
    const html = renderToStaticMarkup(
      <PublicKeysView items={[used]} modules={["support"]} locale="en" onRevoke={() => {}} />,
    );
    expect(html).toContain(publicKeyText("en", "usedBy", "Help desk"));
    expect(html).toContain("Used by: Help desk");
    const question = revokeQuestion(used, "en");
    expect(question).toContain(publicKeyText("en", "revokeAsk"));
    expect(question).toContain(publicKeyText("en", "revokeUsed", "Help desk"));
    expect(question).toContain("\"Help desk\" loses its key");
    expect(revokeQuestion(used, "de")).toContain("\u201EHelp desk\u201C verliert");
  });

  it("asks the short question for a key nobody uses and shows no user line", () => {
    const free = key();
    expect(revokeQuestion(free, "en")).toBe(publicKeyText("en", "revokeAsk"));
    expect(revokeQuestion(free, "de")).toBe(
      "Diesen Schl\u00FCssel widerrufen? Was ihn nutzt, funktioniert sofort nicht mehr.",
    );
    const html = renderToStaticMarkup(
      <PublicKeysView items={[free]} modules={["support"]} locale="en" onRevoke={() => {}} />,
    );
    expect(html).not.toContain("Used by");
    expect(html).toContain("Revoke");
  });

  it("offers no revoke for a revoked key", () => {
    const html = renderToStaticMarkup(
      <PublicKeysView
        items={[key({ revokedAt: "2026-11-02T10:00:00Z" })]}
        modules={["support"]}
        locale="en"
        onRevoke={() => {}}
      />,
    );
    expect(html).toContain("Revoked");
    expect(html).not.toContain(">Revoke<");
  });
});

describe("public keys list in German", () => {
  const view = (items: PublicKeyItem[], modules = ["support"]) =>
    renderToStaticMarkup(
      <PublicKeysView items={items} modules={modules} locale="de" onRevoke={() => {}} />,
    );
  it("reads German for an active, a revoked and an empty list", () => {
    const active = view([key()]);
    expect(active).toContain("Aktiv");
    expect(active).toContain(">Widerrufen<");
    const revoked = view([key({ revokedAt: "2026-11-02T10:00:00Z" })]);
    expect(revoked).toContain("Widerrufen ");
    const empty = view([], []);
    expect(empty).toContain("Noch keine öffentlichen Schlüssel.");
    expect(empty).toContain(
      "Noch kein Modul dieser Installation hat eine öffentliche Schnittstelle.",
    );
    for (const html of [active, revoked, empty])
      for (const english of ["Active", "Revoke", "Revoked", "No public keys yet", "No module of"])
        expect(html).not.toContain(english);
  });
  it("has a German text for every key", () => {
    for (const k of [
      "usedBy", "revokeAsk", "revokeUsed", "ownerOnly", "active", "revoked", "revoke", "none",
      "noModules", "module", "origins", "originsHint", "create", "newKey", "ingressOff",
    ] as const) {
      expect(publicKeyText("de", k, "L", "D")).not.toBe(publicKeyText("en", k, "L", "D"));
    }
  });
});

describe("public access section", () => {
  const OWNER_CAPS = ["project.integrations"] as const;

  it("registers public access under the project's integrations", () => {
    const list = visibleSections(projectSections, "project", [...OWNER_CAPS]);
    const ids = list.filter((s) => s.area === "integrations").map((s) => s.id);
    expect(ids.indexOf("public-access")).toBe(ids.indexOf("google-drive") + 1);
    expect(visibleSections(projectSections, "project", []).map((s) => s.id)).not.toContain("public-access");
    const found = resolveSection(list, "integrations", ["public-access"]);
    expect(found?.section).toMatchObject({
      id: "public-access",
      order: 30,
    });
    expect(found?.section.label).toEqual({ en: "Public access", de: "\u00D6ffentlicher Zugriff" });
  });

  it("shows no keys to someone who is not an owner", () => {
    const html = inWorkspace(false, <PublicAccessSection {...sectionProps} />);
    expect(html).toBe(`<p class="panel-note">${publicKeyText("en", "ownerOnly")}</p>`);
    expect(html).not.toContain("Loading");
  });

  it("lets an owner reach the keys panel", () => {
    const html = inWorkspace(true, <PublicAccessSection {...sectionProps} />);
    expect(html).toContain("Loading");
    expect(html).not.toContain(publicKeyText("en", "ownerOnly"));
  });

  it("keeps the public keys button out of the center's profile section", () => {
    const center = inWorkspace(true, <ProjectAdministration />);
    expect(center).not.toContain("Public keys");
    expect(center).toContain("Edit project");
    expect(center).not.toContain("public client keys");
    const profile = projectSections.find((x) => x.id === "profile")!;
    expect(JSON.stringify(profile.description)).not.toMatch(/public|öffentlich/i);
  });
});
