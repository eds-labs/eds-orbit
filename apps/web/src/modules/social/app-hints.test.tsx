import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHint, HiddenAppsNote, appsToHide, readHiddenApps, writeHiddenApps } from "./app-hints";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hidden developer app notices in storage", () => {
  it("keeps the hidden apps per project", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    writeHiddenApps("p1", new Set(["x"]));
    expect([...readHiddenApps("p1")]).toEqual(["x"]);
    expect([...readHiddenApps("p2")]).toEqual([]);
  });

  it("ignores broken values and unknown apps", () => {
    vi.stubGlobal("localStorage", memoryStorage({ "orbit.social.hiddenApps.p1": "{oops" }));
    expect([...readHiddenApps("p1")]).toEqual([]);
    vi.stubGlobal("localStorage", memoryStorage({ "orbit.social.hiddenApps.p1": JSON.stringify(["x", "tiktok", 3]) }));
    expect([...readHiddenApps("p1")]).toEqual(["x"]);
  });

  it("works without storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect([...readHiddenApps("p1")]).toEqual([]);
    expect(() => writeHiddenApps("p1", new Set(["meta"]))).not.toThrow();
  });
});

describe("which notices are hidden", () => {
  it("hides only apps that are merely not granted", () => {
    const hidden = new Set(["x", "meta"] as const);
    expect(appsToHide({ x: "project_not_granted", meta: "invalid" }, hidden)).toEqual(["x"]);
    expect(appsToHide({ x: "not_granted", meta: "ready" }, hidden)).toEqual(["x"]);
    expect(appsToHide({ x: "ready", meta: "not_granted" }, new Set(["x"] as const))).toEqual([]);
    expect(appsToHide(null, hidden)).toEqual([]);
  });
});

describe("developer app notice", () => {
  const settings = "/o/w1/settings";

  it("points a missing project grant to the organization settings", () => {
    const en = renderToStaticMarkup(
      <AppHint app="x" state="project_not_granted" settingsHref={settings} locale="en" onHide={() => {}} />,
    );
    expect(en).toContain("X is not granted to this project yet");
    expect(en).toContain(
      "Administration &amp; settings → your organization → Integrations → Connections",
    );
    expect(en).toMatch(/<a[^>]*href="\/o\/w1\/settings"[^>]*>Open organization settings<\/a>/);
    expect(en).toMatch(/<button[^>]*aria-label="Hide the X notice"[^>]*>Hide<\/button>/);
    const de = renderToStaticMarkup(
      <AppHint app="meta" state="project_not_granted" settingsHref={settings} locale="de" onHide={() => {}} />,
    );
    expect(de).toContain("Facebook und Instagram sind für dieses Projekt noch nicht freigegeben");
    expect(de).toContain(
      "Verwaltung &amp; Einstellungen → deine Organisation → Integrationen → Verbindungen",
    );
    expect(de).toContain(">Organisationseinstellungen öffnen</a>");
    expect(de).toContain(">Ausblenden</button>");
  });

  it("names the administration first when the organization has no grant", () => {
    const de = renderToStaticMarkup(
      <AppHint app="x" state="not_granted" settingsHref={settings} locale="de" onHide={() => {}} />,
    );
    expect(de).toContain("X ist noch nicht eingerichtet");
    expect(de).toContain(
      "Verwaltung &amp; Einstellungen → Gesamtes System → Integrationen → Zentrale Verbindungen",
    );
    expect(de).toContain(
      "Verwaltung &amp; Einstellungen → deine Organisation → Integrationen → Verbindungen",
    );
    expect(de).not.toContain("Organisationseinstellungen öffnen");
    expect(de).toContain(">Ausblenden</button>");
  });

  it("offers no link without access to the organization settings and no hiding for broken keys", () => {
    const noAccess = renderToStaticMarkup(
      <AppHint app="x" state="project_not_granted" settingsHref={null} locale="en" onHide={() => {}} />,
    );
    expect(noAccess).not.toContain("<a");
    const invalid = renderToStaticMarkup(
      <AppHint app="meta" state="invalid" settingsHref={settings} locale="en" onHide={() => {}} />,
    );
    expect(invalid).toContain("The keys of the Meta app are not valid");
    expect(invalid).not.toContain(">Hide</button>");
  });

  it("lists hidden notices with a way to show them again", () => {
    const de = renderToStaticMarkup(<HiddenAppsNote apps={["x", "meta"]} locale="de" onShow={() => {}} />);
    expect(de).toContain("Ausgeblendet: X, Facebook und Instagram.");
    expect(de).toContain(">Wieder anzeigen</button>");
    const en = renderToStaticMarkup(<HiddenAppsNote apps={["x"]} locale="en" onShow={() => {}} />);
    expect(en).toContain("Hidden: X.");
    expect(en).toContain(">Show again</button>");
  });
});
