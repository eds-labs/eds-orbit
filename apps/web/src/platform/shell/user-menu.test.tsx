import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { labels } from "@/lib/i18n";
import type { Identity } from "@/lib/api";
import { UserMenu, userMenuEntries } from "./user-menu";
import { shortAgent } from "@/platform/account/account-view";
import { errorText } from "@/platform/administration/texts";

const base: Identity = {
  user: { id: "u1", name: "Ada", email: "ada@example.invalid" },
  projects: [],
  workspaces: [{ id: "w1", name: "Org", role: "viewer" }],
};
const t = (k: keyof typeof labels.en) => labels.en[k];

describe("account menu (ADR 0013)", () => {
  it("shows administration only to system administrators", () => {
    expect(userMenuEntries(base, "w1").admin).toBe(false);
    expect(userMenuEntries({ ...base, systemAdmin: true }, "w1").admin).toBe(
      true,
    );
  });

  it("links the organization settings only for an organization the user manages", () => {
    expect(userMenuEntries(base, "w1").organization).toBeNull();
    const owner = {
      ...base,
      workspaces: [
        { id: "w1", name: "Org", role: "owner", canManage: true },
        { id: "w 2", name: "Other", role: "owner", canManage: true },
      ],
    };
    expect(userMenuEntries(owner, "w 2").organization).toBe("/o/w%202/settings");
    // Outside a project: the first organization the user manages.
    expect(userMenuEntries(owner, undefined).organization).toBe(
      "/o/w1/settings",
    );
  });

  it("renders the entries the identity allows", () => {
    const html = (identity: Identity) =>
      renderToStaticMarkup(
        <UserMenu identity={identity} t={t} onSignOut={() => {}} signingOut={false} />,
      );
    expect(html(base)).not.toContain('href="/admin"');
    expect(html(base)).not.toContain('href="/account"');
    const full = html({ ...base, systemAdmin: true, account: true });
    expect(full).toContain('href="/admin"');
    expect(full).toContain('href="/account"');
    expect(full).toContain("ada@example.invalid");
  });
});

describe("account helpers", () => {
  it("names a session's browser and system", () => {
    expect(
      shortAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe("Safari · macOS");
    expect(
      shortAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome · Windows");
  });

  it("turns known error codes into sentences in both languages", () => {
    expect(errorText("LAST OWNER", "en")).toMatch(/at least one active owner/);
    expect(errorText("LAST OWNER", "de")).toMatch(/mindestens einen/);
    expect(errorText("SOMETHING ELSE", "en")).toBe("SOMETHING ELSE");
    expect(errorText(null, "en")).toBeNull();
  });
});
