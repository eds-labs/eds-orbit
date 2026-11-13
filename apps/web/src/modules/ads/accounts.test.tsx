import { beforeEach, describe, expect, it, vi } from "vitest";
const search = vi.hoisted(() => ({ value: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/p/p1/ads/accounts",
  useSearchParams: () => new URLSearchParams(search.value),
}));

const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const apiCalls = vi.hoisted(() => ({ fn: undefined as unknown as ReturnType<typeof import("vitest").vi.fn> }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  const { vi: v } = await import("vitest");
  apiCalls.fn = v.fn();
  return {
    ...actual,
    api: apiCalls.fn,
    useResource: (path: string | null) => {
      // The longest match wins: "/ads/connections" is part of the picker path.
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return {
        data: found ?? null,
        error: found === undefined && path ? Object.assign(new Error("failed"), { status: 404 }) : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { AdsAccounts, RevokeConnectionDialog, permissionSummary } from "./accounts";
import { assignAccount, formatMicros, revokeConnection, startConnect, unlinkAccount, type AdAccountView, type AdConnection } from "./api";
import { accountsMessage, textFor } from "./labels";

const project = { id: "p1", workspaceId: "w1", name: "Synthetic", timezone: "Europe/Berlin", role: "owner" } as Project;
const identity: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const BLOCKED = /(^|[-_])(ad|ads|advert|banner|sponsor)([-_]|$)/i;

function render(node: React.ReactNode, { locale = "en" as Locale, owner = true } = {}) {
  return renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={{
        project,
        identity,
        locale,
        t: (k) => labels[locale][k],
        canEdit: true,
        isOwner: owner,
        revision: 0,
        refresh: () => {},
        href: (p) => p,
      }}
    >
      {node}
    </WorkspaceContext.Provider>,
  );
}

const account = (over: Partial<AdAccountView> = {}): AdAccountView => ({
  id: "acc1",
  provider: "meta",
  externalId: "act_1",
  name: "Brand Account",
  currency: "EUR",
  timezone: "Europe/Berlin",
  status: "active",
  capability: "write_ready",
  writesEnabled: false,
  providerStatus: "ACTIVE",
  spendCapMicros: "500000000",
  amountSpentMicros: "12340000",
  businessId: "b1",
  settings: { dsaBeneficiary: null, dsaPayor: null },
  health: { lastCheckedAt: "2026-11-10T10:00:00.000Z", lastErrorCode: null, nextCheckAt: null },
  connection: { id: "c1", tokenType: "user", tokenExpiresAt: "2099-01-01T12:00:00.000Z" },
  version: 3,
  ...over,
});
const connection = (over: Partial<AdConnection> = {}): AdConnection => ({
  id: "c1", label: "Meta", tokenType: "user", tokenExpiresAt: null, grantedScopes: [], accountCount: 1, disabled: false, createdAt: "2026-11-01T00:00:00.000Z", ...over,
});
const connections = (app: string, list: AdConnection[] = [connection()]) => ({ app, connections: list });
/** The aria-labels of the rendered buttons. */
const named = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]!);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  search.value = "";
  apiCalls.fn.mockReset();
});

describe("ads accounts view (ADR 0025, A3)", () => {
  it("tells an owner whose app is missing what to do and offers no connect button", () => {
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = { app: "not_granted", connections: [] };
    const de = render(<AdsAccounts />, { locale: "de" });
    expect(de).toContain("Eine Administratorin muss die Meta-App für Werbung unter Verwaltung &amp; Einstellungen → Gesamtes System → Integrationen → Zentrale Verbindungen anlegen und freigeben.");
    expect(buttons(de)).not.toContain("Mit Meta verbinden");
    answers["/ads/connections"] = { app: "project_not_granted", connections: [] };
    expect(render(<AdsAccounts />)).toContain("organization owner");
    answers["/ads/connections"] = { app: "invalid", connections: [] };
    expect(render(<AdsAccounts />)).toContain("administration");
  });

  it("shows an owner a failed connections load with a retry and no connect button", () => {
    answers["/ads/accounts"] = { accounts: [] };
    // No answer for the connections path: the mocked resource reports an error.
    for (const [locale, retry] of [["en", "Try again"], ["de", "Try again"]] as const) {
      const html = render(<AdsAccounts />, { locale });
      expect(html).toContain('role="alert"');
      expect(html).toContain("failed");
      expect(html).toContain(retry);
      expect(buttons(html)).not.toContain("Connect with Meta");
      expect(buttons(html)).not.toContain("Mit Meta verbinden");
    }
    // An editor never asks for the connections, so sees no error.
    expect(render(<AdsAccounts />, { owner: false })).not.toContain('role="alert"');
  });

  it("offers the connect button once the app is ready", () => {
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready");
    expect(buttons(render(<AdsAccounts />, { locale: "de" }))).toContain("Mit Meta verbinden");
    expect(buttons(render(<AdsAccounts />))).toContain("Connect with Meta");
  });

  it("connect posts and sends the browser to the provider", async () => {
    apiCalls.fn.mockResolvedValue({ authorizeUrl: "https://meta.example/dialog" });
    const assign = vi.fn();
    await startConnect("p1", assign);
    expect(apiCalls.fn).toHaveBeenCalledWith("/projects/p1/ads/connections/meta/connect", { method: "POST", body: "{}" });
    expect(assign).toHaveBeenCalledWith("https://meta.example/dialog");
  });

  it("opens the picker from ?connection with disabled rows and a truncation hint", () => {
    search.value = "connection=c1";
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready");
    answers["/ads/connections/c1/available-accounts"] = {
      truncated: true,
      accounts: [
        { externalId: "act_1", name: "Free One", currency: "EUR", timezone: "Europe/Berlin", businessName: "Biz GmbH", currencySupported: true, assigned: null },
        { externalId: "act_2", name: "Taken", currency: "EUR", timezone: "Europe/Berlin", businessName: null, currencySupported: true, assigned: "elsewhere" },
        { externalId: "act_3", name: "Odd Currency", currency: "XYZ", timezone: "UTC", businessName: null, currencySupported: false, assigned: null },
      ],
    };
    const html = render(<AdsAccounts />, { locale: "de" });
    for (const text of ["Free One", "act_1", "Biz GmbH", "Europe/Berlin", "In einem anderen Projekt zugeordnet", "Währung wird noch nicht unterstützt"])
      expect(html).toContain(text);
    expect(html).toContain("nicht alle");
    const assignButtons = [...html.matchAll(/<button([^>]*)>\s*Zuordnen\s*<\/button>/g)].map((m) => m[1]!);
    expect(assignButtons).toHaveLength(3);
    expect(assignButtons.filter((a) => /disabled/.test(a))).toHaveLength(2);
    expect(assignButtons[0]).not.toMatch(/disabled/);
  });

  it("assigns with the connection and external id", async () => {
    apiCalls.fn.mockResolvedValue({});
    await assignAccount("p1", "c1", "act_1");
    expect(apiCalls.fn).toHaveBeenCalledWith("/projects/p1/ads/accounts", {
      method: "POST",
      body: JSON.stringify({ connectionId: "c1", externalId: "act_1" }),
    });
  });

  it("shows an editor the accounts without any button", () => {
    answers["/ads/accounts"] = { accounts: [account({ status: "reconnect_required" })] };
    const html = render(<AdsAccounts />, { owner: false });
    expect(html).toContain("Brand Account");
    expect(html).toContain("Needs reconnect");
    expect(buttons(html)).toHaveLength(0);
    expect(html).not.toMatch(/<input/);
  });

  it("shows status, capability, plain provider status, expiry in the project time zone and money", () => {
    answers["/ads/accounts"] = {
      accounts: [
        account({
          providerStatus: "PENDING_RISK_REVIEW",
          connection: { id: "c1", tokenType: "user", tokenExpiresAt: "2026-12-31T23:30:00.000Z" },
          health: { lastCheckedAt: "2026-11-10T10:00:00.000Z", lastErrorCode: "ADS_META_TOKEN_EXPIRED", nextCheckAt: null },
        }),
      ],
    };
    const de = render(<AdsAccounts />, { locale: "de" });
    expect(de).toContain("Aktiv");
    expect(de).toContain("Schreiben möglich");
    expect(de).toContain("In Prüfung bei Meta");
    expect(de).toContain("500,00 €");
    // 23:30 UTC is already the next day in Berlin.
    expect(de).toContain("01.01.2027");
    expect(de).toContain("Das Zugriffstoken ist abgelaufen");
    const verified = render(<AdsAccounts />);
    expect(verified).toContain("Write possible");
  });

  it("warns within 14 days of the token expiry", () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    answers["/ads/accounts"] = { accounts: [account({ connection: { id: "c1", tokenType: "user", tokenExpiresAt: soon } })] };
    expect(render(<AdsAccounts />)).toContain("expires soon");
    answers["/ads/accounts"] = { accounts: [account()] };
    expect(render(<AdsAccounts />)).not.toContain("expires soon");
  });

  it("gives the owner the account actions and the write switch only when write-ready", () => {
    answers["/ads/accounts"] = { accounts: [account(), account({ id: "acc2", name: "Read Only", capability: "read_verified" })] };
    answers["/ads/connections"] = connections("ready");
    const html = render(<AdsAccounts />, { locale: "de" });
    for (const text of ["Prüfen", "Neu verbinden", "Trennen", "Speichern"]) expect(buttons(html)).toContain(text);
    expect(html).toContain("wirkt erst, wenn Orbit Kampagnen ändern kann");
    expect(html).toContain("Begünstigter");
    expect(html).toContain("Zahler");
    const switches = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(switches).toHaveLength(2);
    expect(switches[0]).not.toMatch(/disabled/);
    expect(switches[1]).toMatch(/disabled/);
  });

  it("names every control", () => {
    answers["/ads/accounts"] = { accounts: [account()] };
    answers["/ads/connections"] = connections("ready");
    const html = render(<AdsAccounts />);
    for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
      const id = /\sid="([^"]+)"/.exec(m[1]!)?.[1];
      // Named by aria-label, a label[for], or a wrapping label (the switch).
      const wrapped = html.includes(`<label><input${m[1]!}>`);
      expect(/aria-label="[^"]+"/.test(m[1]!) || wrapped || (id !== undefined && html.includes(`for="${id}"`))).toBe(true);
    }
  });

  it.each([
    ["ADS_OAUTH_CANCELLED", "abgebrochen", "cancelled"],
    ["ADS_OAUTH_STATE_INVALID", "abgelaufen", "expired"],
    ["ADS_META_PERMISSION_MISSING", "Berechtigung", "permission"],
    ["ADS_META_APP_NOT_GRANTED", "nicht freigegeben", "not been granted"],
    ["ADS_META_APP_CHANGED", "geändert", "changed"],
    ["ADS_CONNECT_FAILED", "fehlgeschlagen", "failed"],
    ["ADS_CONNECTION_DISABLED", "Die Administration hat diese Verbindung deaktiviert", "An administrator disabled this connection"],
    ["ADS_SOMETHING_ELSE", "Verbindung fehlgeschlagen", "Connection failed"],
    ["constructor", "Verbindung fehlgeschlagen", "Connection failed"],
  ])("renders the localized message of %s", (code, de, en) => {
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready");
    search.value = `error=${code}`;
    expect(render(<AdsAccounts />, { locale: "de" })).toContain(de);
    expect(render(<AdsAccounts />, { locale: "en" })).toContain(en);
  });

  it("never resolves inherited keys: an unknown code falls back to the generic text", () => {
    search.value = "error=constructor";
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready");
    const html = render(<AdsAccounts />);
    expect(html).not.toContain("function");
    expect(html).toContain("Connection failed");
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(accountsMessage(key, "de")).toBe("Verbindung fehlgeschlagen");
      expect(textFor({ a: 1 }, key, 0)).toBe(0);
    }
    expect(textFor({ a: 1 }, "a", 0)).toBe(1);
    expect(textFor({ a: 1 }, null, 0)).toBe(0);
    answers["/ads/accounts"] = { accounts: [account({ status: "constructor", capability: "toString", providerStatus: "valueOf", health: { lastCheckedAt: null, lastErrorCode: "__proto__", nextCheckAt: null } })] };
    search.value = "";
    const odd = render(<AdsAccounts />);
    expect(odd).toContain("Other status at Meta");
    expect(odd).toContain("Connection failed");
    expect(odd).not.toContain("function");
  });

  it("names each row's controls with the account", () => {
    answers["/ads/accounts"] = { accounts: [account()] };
    answers["/ads/connections"] = connections("ready");
    const de = render(<AdsAccounts />, { locale: "de" });
    expect(named(de)).toEqual(expect.arrayContaining(["Prüfen: Brand Account", "Neu verbinden: Brand Account", "Trennen: Brand Account", "Speichern: Brand Account"]));
    expect(de).toMatch(/<input[^>]*type="checkbox"[^>]*aria-label="Schreibzugriff: Brand Account"|<input[^>]*aria-label="Schreibzugriff: Brand Account"[^>]*type="checkbox"/);
    expect(named(render(<AdsAccounts />))).toEqual(expect.arrayContaining(["Check: Brand Account", "Disconnect: Brand Account"]));
  });

  it("shows the admin-disabled check code on an account", () => {
    answers["/ads/accounts"] = { accounts: [account({ health: { lastCheckedAt: null, lastErrorCode: "ADS_CONNECTION_DISABLED", nextCheckAt: null } })] };
    expect(render(<AdsAccounts />, { locale: "de" })).toContain("Die Administration hat die Verbindung deaktiviert.");
    expect(render(<AdsAccounts />)).toContain("An administrator disabled the connection.");
  });

  it("lists every connection with its own buttons, a connection without accounts too", () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready", [
      connection({ id: "c1", label: "Meta: Ada", grantedScopes: ["ads_management", "ads_read"], accountCount: 2, tokenExpiresAt: "2026-12-31T23:30:00.000Z" }),
      connection({ id: "c2", label: "Meta: Bob", tokenType: "system_user", grantedScopes: ["ads_read"], accountCount: 0, tokenExpiresAt: soon }),
    ]);
    const de = render(<AdsAccounts />, { locale: "de" });
    expect(de).toContain("<h2>Verbindungen</h2>");
    for (const text of ["Meta: Ada", "Meta: Bob", "Nutzer-Token · Lesen und Schreiben · 2 Konten", "Systemnutzer-Token · Lesen · 0 Konten", "01.01.2027"])
      expect(de).toContain(text);
    expect(de.match(/Der Zugriff läuft bald ab/g)).toHaveLength(1);
    expect(named(de)).toEqual(expect.arrayContaining(["Konten auswählen: Meta: Ada", "Widerrufen: Meta: Ada", "Konten auswählen: Meta: Bob", "Widerrufen: Meta: Bob"]));
    const en = render(<AdsAccounts />);
    for (const text of ["<h2>Connections</h2>", "User token · Read and write · 2 accounts", "System user token · Read · 0 accounts"]) expect(en).toContain(text);
    // While the app is not ready nothing can be picked, but revoking still works.
    answers["/ads/connections"] = connections("project_not_granted", [connection({ label: "Meta: Ada" })]);
    const blocked = named(render(<AdsAccounts />));
    expect(blocked).toContain("Revoke: Meta: Ada");
    expect(blocked).not.toContain("Select accounts: Meta: Ada");
  });

  it("marks an admin-disabled connection and offers no picker for it", () => {
    answers["/ads/accounts"] = { accounts: [] };
    answers["/ads/connections"] = connections("ready", [connection({ id: "c1", label: "Meta: Ada" }), connection({ id: "c2", label: "Meta: Bob", disabled: true })]);
    const de = render(<AdsAccounts />, { locale: "de" });
    expect(de.match(/Von der Administration deaktiviert/g)).toHaveLength(1);
    expect(named(de)).toEqual(expect.arrayContaining(["Konten auswählen: Meta: Ada", "Widerrufen: Meta: Bob"]));
    expect(named(de)).not.toContain("Konten auswählen: Meta: Bob");
    expect(render(<AdsAccounts />)).toContain("Disabled by an administrator");
  });

  it("summarizes a grant's permissions", () => {
    expect(permissionSummary(["ads_read", "ads_management"])).toBe("write");
    expect(permissionSummary(["ads_management"])).toBe("write");
    expect(permissionSummary(["ads_read"])).toBe("read");
    expect(permissionSummary(["business_management"])).toBe("none");
  });

  it("revoke asks for confirmation naming the connection and posts", async () => {
    const dialog = render(<RevokeConnectionDialog connection={connection({ label: "Meta: Ada" })} onCancel={() => {}} onConfirm={() => {}} />, { locale: "de" });
    expect(dialog).toContain("<dialog");
    expect(dialog).toContain("Meta: Ada widerrufen?");
    expect(dialog).toContain("löscht ihr Zugriffstoken");
    expect(buttons(dialog)).toEqual(expect.arrayContaining(["Abbrechen", "Widerrufen"]));
    expect(render(<RevokeConnectionDialog connection={connection({ label: "Meta: Ada" })} onCancel={() => {}} onConfirm={() => {}} />)).toContain("Revoke Meta: Ada?");
    apiCalls.fn.mockResolvedValue({ id: "c1", accountsUnlinked: 2 });
    await revokeConnection("p1", "c1");
    expect(apiCalls.fn).toHaveBeenCalledWith("/projects/p1/ads/connections/c1/revoke", { method: "POST", body: "{}" });
  });

  it("shows editors no connection list", () => {
    answers["/ads/accounts"] = { accounts: [account()] };
    answers["/ads/connections"] = connections("ready", [connection({ label: "Meta: Ada" })]);
    const html = render(<AdsAccounts />, { owner: false });
    expect(html).not.toContain("Meta: Ada");
    expect(html).not.toContain("Connections</h2>");
    expect(buttons(html)).toHaveLength(0);
  });

  it("unlink asks for confirmation naming the account and posts the version", async () => {
    apiCalls.fn.mockResolvedValue({ id: "acc1", status: "unlinked", connectionRevoked: false });
    await unlinkAccount("p1", account());
    expect(apiCalls.fn).toHaveBeenCalledWith("/projects/p1/ads/accounts/acc1/unlink", {
      method: "POST",
      body: JSON.stringify({ version: 3 }),
    });
  });

  it("formats micros exactly with the account currency and the locale", () => {
    expect(formatMicros("500000000", "EUR", "de")).toBe("500,00 €");
    expect(formatMicros("12340000", "USD", "en")).toBe("$12.34");
    expect(formatMicros("9007199254740993000000", "USD", "en")).toBe("$9,007,199,254,740,993.00");
    expect(formatMicros("1999999", "EUR", "en")).toBe("€2.00");
    expect(formatMicros(null, "EUR", "en")).toBe("—");
  });

  it("uses no blocker-prone ids or classes", () => {
    answers["/ads/accounts"] = { accounts: [account()] };
    answers["/ads/connections"] = connections("ready");
    search.value = "connection=c1&error=ADS_CONNECT_FAILED";
    answers["/ads/connections/c1/available-accounts"] = { truncated: false, accounts: [] };
    answers["/ads/connections"] = connections("ready", [connection(), connection({ id: "c2", label: "Meta: Bob", disabled: true })]);
    for (const locale of ["en", "de"] as const) {
      const html =
        render(<AdsAccounts />, { locale }) +
        render(<RevokeConnectionDialog connection={connection()} onCancel={() => {}} onConfirm={() => {}} />, { locale });
      for (const m of html.matchAll(/\s(id|class)="([^"]*)"/g))
        for (const token of m[2]!.split(/\s+/).filter(Boolean)) expect(token, token).not.toMatch(BLOCKED);
    }
  });
});
