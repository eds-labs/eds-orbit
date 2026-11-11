import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderCard } from "./provider-card";
import { integrationText, stateLabel } from "./texts";
import type { CardRecord } from "./types";

const entry = {
  id: "postiz",
  label: { en: "Postiz", de: "Postiz" },
  category: "social" as const,
  authType: "api_key" as const,
  storage: ["central" as const, "project" as const],
  available: true,
};
const record = (extra: Partial<CardRecord> = {}): CardRecord => ({
  key: "r1",
  label: "Main account",
  state: "ready",
  checkedAt: "2026-11-10T10:00:00Z",
  ...extra,
});
const t = integrationText("en");

describe("ProviderCard", () => {
  it("shows not set up without records and one row per record", () => {
    const empty = renderToStaticMarkup(
      <ProviderCard entry={entry} records={[]} manageHref={null} manageNote="module" setupHref={null} locale="en" />,
    );
    // Cards sit below the h3 of their category.
    expect(empty).toContain("<h4>Postiz</h4>");
    expect(empty).toContain("Postiz");
    expect(empty).toContain(stateLabel("not_set_up", "en"));
    expect(empty).not.toContain("<li");

    const html = renderToStaticMarkup(
      <ProviderCard
        entry={entry}
        records={[record(), record({ key: "r2", label: "Second", state: "needs_attention", checkedAt: null, detail: "Token expired" })]}
        manageHref="/manage/system/connections"
        manageNote={null}
        setupHref="/manage/system/connections?setup=postiz"
        locale="en"
      />,
    );
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("Main account");
    expect(html).toContain(stateLabel("ready", "en"));
    expect(html).toContain(stateLabel("needs_attention", "en"));
    expect(html).toContain(t("neverChecked"));
    expect(html).toContain(t("lastCheck"));
    expect(html).toContain("Token expired");
    expect(html).toContain(`href="/manage/system/connections"`);
    expect(html).toContain(t("manage"));
    expect(html).toContain(t("setUp"));
    expect(html).not.toContain(stateLabel("not_set_up", "en"));
  });

  it("treats an unparsable check time as never checked", () => {
    const html = renderToStaticMarkup(
      <ProviderCard entry={entry} records={[record({ checkedAt: "garbage" })]} manageHref={null} manageNote="module" setupHref={null} locale="en" />,
    );
    expect(html).toContain(t("neverChecked"));
  });

  it("offers no action on an unavailable entry", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        entry={{ ...entry, available: false }}
        records={[record()]}
        manageHref="/x"
        manageNote={null}
        setupHref="/y"
        locale="en"
      />,
    );
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).toContain(t("switchedOff"));
    expect(html).not.toContain("<li");
    expect(html).not.toContain(stateLabel("ready", "en"));
    expect(html).not.toContain("Main account");
    expect(html).not.toContain(t("manage"));
    expect(html).not.toContain(t("setUp"));
  });

  it("says where it is managed when no section manages it", () => {
    const html = renderToStaticMarkup(
      <ProviderCard entry={entry} records={[record()]} manageHref={null} manageNote="module" setupHref={null} locale="en" />,
    );
    expect(html).toContain(t("managedInModule"));
    expect(html).not.toMatch(/<a[\s>]/);
  });
});

describe("ProviderCard notes and environment entries", () => {
  const systemMail = {
    id: "system_mail",
    label: { en: "System e-mail", de: "System-E-Mail" },
    category: "email" as const,
    authType: "environment" as const,
    storage: ["environment" as const],
    available: true,
  };
  const render = (
    note: "module" | "organization" | "server" | null,
    locale: "en" | "de" = "en",
    e: Parameters<typeof ProviderCard>[0]["entry"] = entry,
  ) =>
    renderToStaticMarkup(
      <ProviderCard entry={e} records={[]} manageHref={null} manageNote={note} setupHref={null} locale={locale} />,
    );

  it("says what the reason for the missing link is, in both languages", () => {
    for (const locale of ["en", "de"] as const) {
      const text = integrationText(locale);
      expect(render("server", locale)).toContain(text("managedOnServer"));
      expect(render("organization", locale)).toContain(text("managedInOrganization"));
      expect(render("module", locale)).toContain(text("managedInModule"));
      expect(render("server", locale)).not.toContain(text("managedInModule"));
      expect(render("organization", locale)).not.toContain(text("managedInModule"));
    }
    expect(t("managedOnServer")).toBe("Set on the server.");
    expect(t("managedInOrganization")).toBe("Managed in the organization.");
    expect(integrationText("de")("managedOnServer")).toBe("Auf dem Server gesetzt.");
    expect(integrationText("de")("managedInOrganization")).toBe("Wird in der Organisation verwaltet.");
  });

  it("shows no state for an environment entry without records", () => {
    const html = render("server", "en", systemMail);
    expect(html).not.toContain(stateLabel("not_set_up", "en"));
    expect(html).not.toContain('class="badge');
    expect(html).toContain(t("managedOnServer"));
    // A central entry without records still says it is not set up.
    expect(render("organization")).toContain(stateLabel("not_set_up", "en"));
  });

  it("keeps the actions in one row at the bottom of the card", () => {
    const html = renderToStaticMarkup(
      <ProviderCard entry={entry} records={[]} manageHref="/m" manageNote={null} setupHref="/s" locale="en" />,
    );
    const actions = html.slice(html.indexOf('class="integration-actions"'));
    expect(actions).toContain('href="/m"');
    expect(actions).toContain('href="/s"');
  });
});

describe("ProviderCard with unknown vocabulary", () => {
  it("renders the raw values in the meta line", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        entry={{ ...entry, category: "quantum" as never, authType: "telepathy" as never, storage: ["vault" as never] }}
        records={[]}
        manageHref={null}
        manageNote="module"
        setupHref={null}
        locale="en"
      />,
    );
    expect(html).toContain("quantum");
    expect(html).toContain("telepathy");
    expect(html).toContain("vault");
  });
});
