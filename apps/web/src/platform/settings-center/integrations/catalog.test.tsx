import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { catalogGroups, CatalogView, NOT_AVAILABLE_YET } from "./catalog";
import { categoryLabel, integrationText, stateLabel } from "./texts";
import type { CatalogEntry } from "./types";

const entry = (extra: Partial<CatalogEntry> & Pick<CatalogEntry, "id">): CatalogEntry => ({
  label: { en: extra.id, de: extra.id },
  category: "other",
  authType: "api_key",
  scopes: [],
  checkable: true,
  storage: [],
  available: true,
  owner: "platform",
  ...extra,
});
const entries = [
  entry({ id: "postiz", category: "social", scopes: ["project", "workspace", "system"], storage: ["central", "project"] }),
  entry({ id: "openai", category: "ai", scopes: ["system", "workspace"], storage: ["central"] }),
  entry({ id: "google_drive", category: "google", scopes: ["project"], storage: ["project"] }),
  entry({ id: "system_mail", category: "email", scopes: [], storage: ["environment"], authType: "environment" }),
  entry({ id: "hidden", category: "social", scopes: ["system"], available: false }),
];
const cats = (scope: "system" | "organization" | "project") =>
  catalogGroups(entries, scope).map((g) => g.category);
const t = integrationText("en");

describe("catalogGroups", () => {
  it("groups available entries by category per scope", () => {
    expect(cats("system")).toEqual(["email", "social", "ai"]);
    expect(cats("organization")).toEqual(["social", "ai"]);
    expect(cats("project")).toEqual(["social", "google", "ai"]);
    expect(catalogGroups(entries, "account")).toEqual([]);
  });

  it("keeps the received order within a group and leaves unavailable and environment-only entries out", () => {
    const group = catalogGroups(
      [entry({ id: "b", category: "ai", scopes: ["system"] }), entry({ id: "a", category: "ai", scopes: ["system"] }), entry({ id: "u", category: "ai", scopes: ["system"], available: false })],
      "system",
    )[0]!;
    expect(group.entries.map((e) => e.id)).toEqual(["b", "a"]);
    // An environment-storage entry never shows outside the system scope.
    expect(
      catalogGroups([entry({ id: "e", scopes: ["project"], storage: ["environment"] })], "project"),
    ).toEqual([]);
  });
});

describe("CatalogView", () => {
  it("lists TikTok and external MCP servers without actions, with unavailable entries", () => {
    const html = renderToStaticMarkup(
      <CatalogView
        groups={catalogGroups(entries, "system")}
        unavailable={[entries[4]!]}
        recordsOf={() => []}
        manageHrefOf={() => "/manage/x"}
        setupHrefOf={() => "/manage/y"}
        extra={<p>EXTRA-PANEL</p>}
        locale="en"
      />,
    );
    expect(html).toContain("EXTRA-PANEL");
    expect(html).toContain(`>${categoryLabel("social", "en")}</h2>`);
    expect(html).toContain(t("notAvailableYet"));
    for (const item of NOT_AVAILABLE_YET) expect(html).toContain(item.label.en);
    expect(html).toContain(t("notAvailableBody"));
    expect(html).toContain("hidden");

    // The not-available group is the last section; it must offer nothing.
    const tail = html.slice(html.lastIndexOf("<section"));
    expect(tail).toContain(t("notAvailableYet"));
    expect(tail).not.toMatch(/<a[\s>]/);
    expect(tail).not.toContain(t("manage"));
    expect(tail).not.toContain(t("setUp"));
    expect(tail).not.toContain(stateLabel("ready", "en"));
    expect(tail).not.toContain(stateLabel("verified", "en"));
    expect(tail).not.toContain("badge");
    // Available cards in the other groups keep their actions.
    expect(html.slice(0, html.lastIndexOf("<section"))).toContain(t("setUp"));
  });

  it("renders in German", () => {
    const html = renderToStaticMarkup(
      <CatalogView groups={[]} unavailable={[]} recordsOf={() => []} manageHrefOf={() => null} setupHrefOf={() => null} locale="de" />,
    );
    expect(html).toContain(integrationText("de")("notAvailableYet"));
    expect(html).toContain("TikTok");
    expect(html).toContain("MCP-Server anderer Anbieter");
  });
});
