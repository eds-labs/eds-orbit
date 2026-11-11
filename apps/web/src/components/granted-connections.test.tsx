import { describe, expect, it, vi } from "vitest";

const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const requested = vi.hoisted(() => [] as Array<string | null>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => (requested.push(path), {
      data: path ? (answers[path] ?? null) : null,
      error: null,
      loading: false,
      refresh: () => {},
    }),
  };
});
vi.mock("./workspace-context", () => ({
  useWorkspace: () => ({
    project: { id: "p1" },
    isOwner: true,
    identity: { connections: true },
    locale: "en",
    refresh: () => {},
  }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "@/lib/api";
import { GrantedConnections } from "./granted-connections";

const grant = (grantId: string, connectionId: string, provider: string, label: string) => ({
  grantId,
  connectionId,
  provider,
  scope: "system",
  label,
  status: "configured",
  purposes: [],
});
Object.assign(answers, {
  "/projects/p1/connections": {
    items: [grant("g1", "c1", "postiz", "Postiz main"), grant("g2", "c2", "github_app", "GitHub App")],
  },
  "/projects/p1/workflow-runs": {
    items: [{ id: "r1", event: "content.published", status: "completed", errorCode: null, executionId: "x1" }],
  },
});
const connectors = [{ id: "k1", data: { centralConnectionId: "c1" } }] as unknown as Entity[];

describe("granted connections", () => {
  it("renders as before without a provider", () => {
    const plain = renderToStaticMarkup(<GrantedConnections connectors={connectors} />);
    expect(renderToStaticMarkup(<GrantedConnections connectors={connectors} provider={undefined} />)).toBe(plain);
    expect(plain).toContain("Postiz main");
    expect(plain).toContain("GitHub App");
    expect(plain).toContain("content.published");
  });

  it("shows only the grants of the provider", () => {
    const html = renderToStaticMarkup(<GrantedConnections connectors={connectors} provider="github_app" />);
    expect(html).toContain("GitHub App");
    expect(html).toContain(">Bind<");
    expect(html).not.toContain("Postiz main");
    // Workflow runs belong to no granted provider of a setup.
    expect(html).not.toContain("content.published");
    expect(renderToStaticMarkup(<GrantedConnections connectors={connectors} provider="tiktok" />)).toBe("");
  });

  it("requests the workflow runs only without a provider", () => {
    requested.length = 0;
    renderToStaticMarkup(<GrantedConnections connectors={connectors} provider="github_app" />);
    expect(requested).toEqual(["/projects/p1/connections", null]);
    requested.length = 0;
    renderToStaticMarkup(<GrantedConnections connectors={connectors} />);
    expect(requested).toEqual(["/projects/p1/connections", "/projects/p1/workflow-runs"]);
  });
});
