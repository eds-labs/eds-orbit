import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const asked = vi.hoisted(() => [] as Array<string | null>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      asked.push(path);
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      return {
        data: key === undefined || !path ? null : answers[key],
        error: null,
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
import {
  cmsSettings,
  formOfSite,
  parseLocales,
  siteBody,
  type ManagedSite,
} from "./settings-sections";
import { cmsIntegrations } from "./integrations";
import { cmsWeb } from "./manifest";
import { cmsText } from "./labels";

const project = {
  id: "p1",
  workspaceId: "w1",
  name: "FamilyPlan",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u1", name: "Mario", email: "owner@example.invalid" },
  workspaces: [{ id: "w1", name: "Org", role: "owner" }],
  projects: [project],
};
const render = (
  node: React.ReactNode,
  { locale = "en" as Locale, owner = true } = {},
) =>
  renderToStaticMarkup(
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
const Section = ({ index }: { index: number }) => (
  <>{cmsSettings[index]!.useSection()!.content}</>
);

const site: ManagedSite = {
  id: "s1",
  name: "FamilyPlan",
  baseUrl: "https://familyplan.example",
  locales: ["de", "en"],
  defaultLocale: "de",
  routes: { article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } },
  trailingSlash: true,
  adapter: "orbit_pull",
  adapterConfig: {
    liveCheck: true,
    revisionMeta: "orbit-revision",
    previewPath: "/api/preview",
  },
  notifiers: [{ kind: "webhook", endpointId: "h1" }],
  contentRules: {
    forbiddenPhrases: ["kostenlos"],
    plainText: false,
    titleMaxLength: 60,
    excerptRequired: true,
    heroRequired: false,
  },
  verification: "read_verified",
  archived: false,
  version: 3,
};

describe("content settings sections (CH1.14f)", () => {
  it("contributes the websites and publishing sections and two integrations", () => {
    expect(cmsWeb.settings?.map((s) => s.tab.key)).toEqual([
      "cms-sites",
      "cms-publishing",
    ]);
    expect(cmsWeb.integrations?.map((i) => i.id)).toEqual([
      "api-keys",
      "webhooks",
    ]);
    expect(cmsIntegrations[0]!.label.de).toBe("API-Schlüssel");
  });

  it("turns the form back into the site body it came from", () => {
    expect(parseLocales(" de, en ,de,, fr")).toEqual(["de", "en", "fr"]);
    const body = siteBody(formOfSite(site));
    expect(body).toEqual({
      name: "FamilyPlan",
      baseUrl: "https://familyplan.example",
      locales: ["de", "en"],
      defaultLocale: "de",
      routes: { article: { de: "/blog/{slug}/", en: "/en/blog/{slug}/" } },
      trailingSlash: true,
      adapterConfig: {
        liveCheck: true,
        revisionMeta: "orbit-revision",
        previewPath: "/api/preview",
      },
      notifiers: [{ kind: "webhook", endpointId: "h1" }],
      contentRules: {
        forbiddenPhrases: ["kostenlos"],
        plainText: false,
        titleMaxLength: 60,
        excerptRequired: true,
        heroRequired: false,
      },
    });
    const fresh = siteBody({
      ...formOfSite(null),
      name: " Neu ",
      baseUrl: "https://neu.example",
      locales: "en",
      forbidden: "a\n  ok  \n",
    });
    expect(fresh).toMatchObject({
      name: "Neu",
      locales: ["en"],
      defaultLocale: "en",
      routes: {},
      notifiers: [],
    });
    expect(fresh.contentRules.forbiddenPhrases).toEqual(["ok"]);
    expect(fresh.adapterConfig.previewPath).toBeNull();
  });

  it("lists websites; only the owner manages them and reads webhook endpoints", () => {
    answers["/sites"] = { items: [site] };
    answers["/webhooks"] = {
      items: [
        {
          id: "h1",
          name: "FP",
          url: "https://fp.example/hook",
          ownerModule: "cms",
          status: "active",
        },
      ],
    };
    const t = cmsText("en").settings;
    const owner = render(<Section index={0} />);
    expect(owner).toContain("FamilyPlan");
    expect(owner).toContain(t.verification.read_verified);
    expect(owner).toContain("de: /blog/{slug}/");
    expect(owner).toContain(t.verify);
    expect(owner).toContain(t.testNotifiers);
    expect(owner).toContain(t.newSite);
    asked.length = 0;
    const member = render(<Section index={1 - 1} />, { owner: false });
    expect(member).toContain(t.ownerOnly);
    expect(member).not.toContain(t.newSite);
    expect(asked.some((path) => path?.includes("/webhooks"))).toBe(false);
  });

  it("shows the publishing rules; members read them only", () => {
    answers["/status"] = {
      module: "cms",
      version: "0.1.0",
      settings: {
        publishApprovers: "owner",
        fourEyes: true,
        timeZone: null,
        lateWindowHours: 24,
      },
      settingsVersion: 2,
    };
    const t = cmsText("de").settings;
    const html = render(<Section index={1} />, { locale: "de" });
    expect(html).toContain(t.approverOwner);
    expect(html).toContain('value="24"');
    expect(html).toContain(`>${t.save}<`);
    const member = render(<Section index={1} />, {
      locale: "de",
      owner: false,
    });
    expect(member).toContain("disabled");
    expect(member).not.toContain(`>${t.save}<`);
  });

  it("shows API keys and webhook endpoints to owners only", () => {
    answers["/api-keys"] = {
      items: [
        {
          id: "k1",
          name: "Website",
          prefix: "ok_ab12",
          scopes: ["cms:delivery.read"],
          resourceFilter: {},
          expiresAt: null,
          lastUsedAt: null,
          status: "active",
        },
      ],
      scopes: [
        {
          key: "cms:delivery.read",
          module: "cms",
          access: "read",
          description: "Published content",
        },
      ],
    };
    const Keys = cmsIntegrations[0]!.component;
    const Hooks = cmsIntegrations[1]!.component;
    const t = cmsText("en").integrations;
    const keys = render(<Keys />);
    expect(keys).toContain("ok_ab12");
    expect(keys).toContain(t.revoke);
    expect(keys).toContain(t.newKey);
    // Registered descriptions come in both languages.
    expect(keys).toContain("Published content");
    expect(render(<Keys />, { owner: false })).not.toContain("ok_ab12");
    answers["/webhooks"] = {
      items: [
        {
          id: "h1",
          ownerModule: "cms",
          name: "FP",
          url: "https://fp.example/hook",
          eventTypes: ["cms.entry.published"],
          status: "active",
          consecutiveFailures: 0,
          disabledReason: null,
          version: 1,
        },
      ],
      events: [
        {
          type: "cms.entry.published",
          module: "cms",
          description: "First publication",
        },
      ],
    };
    const hooks = render(<Hooks />);
    expect(hooks).toContain("https://fp.example/hook");
    expect(hooks).toContain(t.rotate);
    expect(hooks).toContain("cms.entry.published");
    expect(hooks).toContain("First publication");
  });
});
