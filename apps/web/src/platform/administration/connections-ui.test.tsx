import { describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: () => ({ data: list.value, error: null, loading: false, refresh: () => {} }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionsPanel } from "./connections-ui";

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
});
