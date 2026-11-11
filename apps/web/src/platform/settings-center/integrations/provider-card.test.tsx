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
      <ProviderCard entry={entry} records={[]} manageHref={null} setupHref={null} locale="en" />,
    );
    expect(empty).toContain("<h3");
    expect(empty).toContain("Postiz");
    expect(empty).toContain(stateLabel("not_set_up", "en"));
    expect(empty).not.toContain("<li");

    const html = renderToStaticMarkup(
      <ProviderCard
        entry={entry}
        records={[record(), record({ key: "r2", label: "Second", state: "needs_attention", checkedAt: null, detail: "Token expired" })]}
        manageHref="/manage/system/connections"
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
      <ProviderCard entry={entry} records={[record({ checkedAt: "garbage" })]} manageHref={null} setupHref={null} locale="en" />,
    );
    expect(html).toContain(t("neverChecked"));
  });

  it("offers no action on an unavailable entry", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        entry={{ ...entry, available: false }}
        records={[record()]}
        manageHref="/x"
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
      <ProviderCard entry={entry} records={[record()]} manageHref={null} setupHref={null} locale="en" />,
    );
    expect(html).toContain(t("managedInModule"));
    expect(html).not.toMatch(/<a[\s>]/);
  });
});

describe("ProviderCard with unknown vocabulary", () => {
  it("renders the raw values in the meta line", () => {
    const html = renderToStaticMarkup(
      <ProviderCard
        entry={{ ...entry, category: "quantum" as never, authType: "telepathy" as never, storage: ["vault" as never] }}
        records={[]}
        manageHref={null}
        setupHref={null}
        locale="en"
      />,
    );
    expect(html).toContain("quantum");
    expect(html).toContain("telepathy");
    expect(html).toContain("vault");
  });
});
