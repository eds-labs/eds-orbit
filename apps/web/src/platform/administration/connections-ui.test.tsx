import { describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => ({ value: null as unknown, byPath: {} as Record<string, unknown> }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => ({
      data: path && path in list.byPath ? list.byPath[path] : list.value,
      error: null,
      loading: false,
      refresh: () => {},
    }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { DataForm } from "@/platform/ui/form";
import { ConnectionsPanel, OrganizationGrantForm, createFields, grantRequests, secretOf } from "./connections-ui";
import { errorText } from "./texts";

const xApp = {
  id: "social.app.x",
  label: { en: "X app", de: "X-App" },
  scopes: ["system"],
  purposes: ["social_oauth"],
  checkable: false,
  callbackPath: "/api/social/oauth/callback/x",
  secretFields: [
    { key: "clientId", label: { en: "Client ID", de: "Client-ID" }, pattern: ".{10,200}", hint: { en: "Keys and tokens", de: "Keys and tokens" } },
    { key: "clientSecret", label: { en: "Client secret", de: "Client-Secret" }, secret: true, pattern: ".{10,200}" },
  ],
};
const openai = { id: "openai", label: { en: "OpenAI", de: "OpenAI" }, scopes: ["system"], purposes: ["text"], checkable: true };

const connection = (id: string, provider: string) => ({
  id,
  provider,
  scope: "system",
  label: provider,
  config: {},
  status: "configured",
  health: {},
  monthlyBudgetMicros: null,
  secretVersion: 1,
  activeGrants: 1,
  disabled: false,
});

/**
 * The administration's connection list (ADR 0014): a provider that cannot
 * be checked on its own (the X developer app needs a signed-in account)
 * offers no "Check" that could only fail.
 */
describe("connections panel", () => {
  it("offers a check only for providers that can be checked", () => {
    list.value = {
      items: [connection("c1", "openai"), connection("c2", "social.app.x")],
      providers: [
        { id: "openai", label: { en: "OpenAI", de: "OpenAI" }, scopes: ["system"], purposes: ["text"], checkable: true },
        { id: "social.app.x", label: { en: "X app", de: "X-App" }, scopes: ["system"], purposes: ["social_oauth"], checkable: false },
      ],
    };
    const en = renderToStaticMarkup(<ConnectionsPanel base="/admin/connections" mode="admin" locale="en" targets={[]} />);
    expect(en.match(/>Check</g)).toHaveLength(1);
    expect(en).toContain("Checked when first used");
    const de = renderToStaticMarkup(<ConnectionsPanel base="/admin/connections" mode="admin" locale="de" targets={[]} />);
    expect(de.match(/>Prüfen</g)).toHaveLength(1);
    expect(de).toContain("Wird bei der ersten Nutzung geprüft");
  });

  it("asks for each key of a developer app in its own field and shows the callback to copy", () => {
    const fields = createFields([openai, xApp], "admin", "de", "https://orbit.example");
    const html = renderToStaticMarkup(
      <DataForm
        fields={fields.map((f) => (f.name === "provider" ? { ...f, value: "social.app.x" } : f))}
        onSubmit={() => {}}
        pending={false}
      />,
    );
    expect(html).toContain("Client-ID");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*name="secret:social.app.x:clientSecret"|<input[^>]*name="secret:social.app.x:clientSecret"[^>]*type="password"/);
    expect(html).toContain('pattern=".{10,200}"');
    expect(html).toContain('value="https://orbit.example/api/social/oauth/callback/x"');
    expect(html).toContain("readOnly");
    expect(html).toContain("Kopieren");
    expect(html).not.toContain("API-Schlüssel oder Token");
    expect(html).not.toContain("Basis-URL");
    expect(html).not.toContain("Monatsbudget");
    const plain = renderToStaticMarkup(
      <DataForm fields={fields.map((f) => (f.name === "provider" ? { ...f, value: "openai" } : f))} onSubmit={() => {}} pending={false} />,
    );
    expect(plain).toContain("API-Schlüssel oder Token");
    expect(plain).not.toContain("Client-ID");
  });

  it("explains a refused developer app key in words", () => {
    // useMutation keeps the message, which has spaces for underscores.
    expect(errorText("SOCIAL APP INVALID", "de")).toContain("Prüfe die einzelnen Felder");
    expect(errorText("SOCIAL APP INVALID", "en")).toContain("Check each field");
  });

  it("builds the JSON secret from the separate fields", () => {
    expect(
      JSON.parse(secretOf(xApp, { "secret:social.app.x:clientId": " client-123456 ", "secret:social.app.x:clientSecret": "s3cret-value-1" })),
    ).toEqual({ clientId: "client-123456", clientSecret: "s3cret-value-1" });
    expect(secretOf(openai, { secret: "sk-plain" })).toBe("sk-plain");
  });

  it("grants an organization and its projects in one step, without touching an existing organization grant", () => {
    expect(grantRequests({ grants: [], workspaceId: "w1", projectIds: ["p1", "p2"], purposes: ["social_oauth"], budgetMicros: undefined })).toEqual([
      { workspaceId: "w1", purposes: ["social_oauth"] },
      { workspaceId: "w1", projectId: "p1", purposes: ["social_oauth"] },
      { workspaceId: "w1", projectId: "p2", purposes: ["social_oauth"] },
    ]);
    const grants = [
      { id: "g1", workspaceId: "w1", workspaceName: "Org", projectId: null, projectName: null, purposes: ["text"], monthlyBudgetMicros: 5_000_000, reservedMicros: 0, settledMicros: 0 },
      { id: "g2", workspaceId: "w1", workspaceName: "Org", projectId: "p1", projectName: "A", purposes: ["text"], monthlyBudgetMicros: null, reservedMicros: 0, settledMicros: 0 },
    ];
    // The organization keeps its grant (a new one would end its project grants);
    // a project already granted is left alone; purposes stay within the organization's.
    expect(grantRequests({ grants, workspaceId: "w1", projectIds: ["p1", "p2"], purposes: ["text", "image"], budgetMicros: 9_000_000 })).toEqual([
      { workspaceId: "w1", projectId: "p2", purposes: ["text"] },
    ]);
    expect(grantRequests({ grants: [], workspaceId: "w1", projectIds: [], purposes: ["text"], budgetMicros: 2_000_000 })).toEqual([
      { workspaceId: "w1", purposes: ["text"], monthlyBudgetMicros: 2_000_000 },
    ]);
  });

  it("lists the organization's projects to grant together with the organization", () => {
    list.byPath["/admin/projects?workspaceId=w1"] = {
      items: [
        { id: "p1", name: "uLiquid", workspace: { id: "w1", name: "Orbit" } },
        { id: "p2", name: "FamilyPlan", workspace: { id: "w1", name: "Orbit" } },
      ],
      nextCursor: null,
    };
    const grants = [
      { id: "g1", workspaceId: "w1", workspaceName: "Orbit", projectId: null, projectName: null, purposes: [], monthlyBudgetMicros: null, reservedMicros: 0, settledMicros: 0 },
      { id: "g2", workspaceId: "w1", workspaceName: "Orbit", projectId: "p1", projectName: "uLiquid", purposes: [], monthlyBudgetMicros: null, reservedMicros: 0, settledMicros: 0 },
    ];
    const html = renderToStaticMarkup(
      <OrganizationGrantForm
        targets={[{ id: "w1", name: "Orbit" }]}
        grants={grants}
        purposes={["social_oauth"]}
        budgetRequired={false}
        locale="de"
        pending={false}
        initialOrganization="w1"
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain("FamilyPlan");
    expect(html).toContain("uLiquid");
    expect(html).toContain("bereits freigegeben");
    expect(html).toContain("Die Organisation ist schon freigegeben");
    delete list.byPath["/admin/projects?workspaceId=w1"];
  });
});

