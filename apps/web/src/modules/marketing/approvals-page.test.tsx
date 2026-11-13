import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search.value),
}));

const search = vi.hoisted(() => ({ value: "" }));
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      return {
        data: found ?? null,
        error:
          found === undefined && path
            ? Object.assign(new Error("failed"), { status: 404 })
            : null,
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
import { webRegistry } from "@/modules/registry";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { shellLinks } from "@/platform/shell/shell-links";
import { projectHref, routeTable } from "@/platform/shell/routes";
import { ApprovalInbox, DraftDecisionSection } from "./work";

const table = routeTable(webRegistry);
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
const FB = "social:11111111-1111-4111-8111-111111111111";
const IG = "social:22222222-2222-4222-8222-222222222222";

function render(
  node: React.ReactNode,
  { locale = "de" as Locale, access = "owner" } = {},
) {
  const module = (id: string) => ({
    id,
    access,
    enabled: true,
    nav: [],
    displayName: { en: "", de: "" },
    description: { en: "", de: "" },
  });
  const hrefOf = (key: string) =>
    projectHref(project.id, table.routes.find((r) => r.key === key)!);
  const shell = {
    hrefOf,
    ...shellLinks({ hrefOf, projectId: project.id, map: (h) => h }),
    modules: [module("marketing"), module("social")],
    table,
    features: {},
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: access !== "viewer",
          isOwner: access === "owner",
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        {node}
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

const row = (
  kind: string,
  id: string,
  data: Record<string, unknown>,
  updatedAt = "2026-11-09T08:00:00.000Z",
) => ({
  id,
  kind,
  version: 2,
  workspaceId: "w1",
  projectId: "p1",
  createdAt: updatedAt,
  updatedAt,
  data,
});
const slot = "2026-11-09T17:30:00.000Z";
const released = "2026-11-09T07:12:00.000Z";
/** The 09.11.2026 pair: released by the owner in Marketing, held in Social. */
function seed() {
  answers["/content?"] = {
    items: [
      row("content", "c-open", {
        title: "Offener Beitrag",
        status: "needs_review",
        channel: FB,
        type: "social",
      }),
      row("content", "c-rev", {
        title: "Geprüfter Beitrag",
        status: "reviewed",
        channel: IG,
        type: "social",
      }),
      row("content", "c-fb", {
        title: "Familienabend",
        status: "reviewed",
        channel: FB,
        type: "social",
      }),
      row("content", "c-ig", {
        title: "Familienabend",
        status: "reviewed",
        channel: IG,
        type: "social",
        sharedFrom: { contentId: "c-fb" },
      }),
      row("content", "c-pub", {
        title: "Letzte Woche",
        status: "reviewed",
        channel: FB,
        type: "social",
      }),
      row("content", "c-old", {
        title: "Alter Entwurf",
        status: "archived",
        channel: FB,
        type: "social",
      }),
    ],
  };
  const publication = (id: string, contentId: string, postId: string) =>
    row("publications", id, {
      contentId,
      status: "intent_created",
      scheduledAt: slot,
      ownerReleasedAt: released,
      ownerReleasedBy: "u1",
      socialPostId: postId,
      socialHold: { state: "held" },
    });
  answers["/publications?"] = {
    items: [
      publication("p-fb", "c-fb", "s-fb"),
      publication("p-ig", "c-ig", "s-ig"),
      row("publications", "p-old", {
        contentId: "c-pub",
        status: "published",
        scheduledAt: "2026-11-02T17:30:00.000Z",
      }),
    ],
  };
  answers["/postiz_drafts?"] = { items: [] };
  answers["/exceptions?"] = { items: [] };
  answers["/marketing/channels"] = {
    items: [
      {
        id: FB,
        name: "FamilyPlan",
        platform: "facebook",
        source: "social",
        active: true,
      },
      {
        id: IG,
        name: "@familyplan.app",
        platform: "instagram",
        source: "social",
        active: true,
      },
    ],
  };
}

describe("approvals page in lanes (WP3)", () => {
  it("speaks German, sorts rows into lanes and has no raw table", () => {
    seed();
    search.value = "";
    const html = render(<ApprovalInbox />);
    for (const heading of [
      "Offene Aktionen",
      "Aufräumen",
      "Geprüft, nicht eingeplant",
      "Freigegeben &amp; geplant",
      "Verlauf",
    ])
      expect(html).toContain(heading);
    expect(html).not.toContain("Updated At");
    expect(html).not.toContain("<table");
    expect(html).not.toMatch(/>social:/);
    // The open content row is an open action; the reviewed one is apart.
    const lane = (title: string) => {
      const start = html.indexOf(title);
      const next = html.indexOf('class="approval-lane', start + 1);
      return html.slice(start, next < 0 ? undefined : next);
    };
    expect(lane("Offene Aktionen")).toContain("Offener Beitrag");
    expect(lane("Offene Aktionen")).not.toContain("Familienabend");
    expect(lane("Geprüft, nicht eingeplant")).toContain("Geprüfter Beitrag");
    expect(lane("Verlauf")).toContain("Letzte Woche");
    expect(lane("Verlauf")).toContain("Alter Entwurf");
    // The cleanup is explained beside its button.
    expect(html).toContain("Alte Entwürfe archivieren");
    expect(html).toContain("an denen nichts mehr hängt");
  });

  it("moves an assignment draft whose mission slot passed to cleanup, as the server does", () => {
    seed();
    search.value = "";
    const content = answers["/content?"] as { items: unknown[] };
    answers["/content?"] = {
      items: [
        ...content.items,
        row("content", "c-draft", {
          title: "Verpasster Termin",
          status: "needs_review",
          channel: FB,
          type: "social",
          assignmentRunId: "run-1",
          missionId: "mission-1",
        }),
      ],
    };
    answers["/missions?"] = {
      items: [
        row("missions", "mission-1", {
          title: "Abendbeitrag",
          plannedSlotAt: "2026-11-08T17:30:00.000Z",
        }),
      ],
    };
    try {
      const html = render(<ApprovalInbox />);
      const between = (from: string, to: string) =>
        html.slice(html.indexOf(from), html.indexOf(to));
      const open = between("Offene Aktionen", "approvals-cleanup-title");
      expect(open).not.toContain("Verpasster Termin");
      expect(open).toContain('lane-count">(1)<');
      expect(
        between("approvals-cleanup-title", "approvals-reviewed-title"),
      ).toContain("Verpasster Termin");
    } finally {
      delete answers["/missions?"];
    }
  });

  it("shows the released 09.11 pair once, released by the owner, with its Social posts", () => {
    seed();
    search.value = "";
    const html = render(<ApprovalInbox />);
    const releasedLane = html.slice(html.indexOf("Freigegeben &amp; geplant"));
    expect(releasedLane.match(/>Familienabend</g)).toHaveLength(1);
    expect(releasedLane).toContain("FamilyPlan · Facebook");
    expect(releasedLane).toContain("@familyplan.app · Instagram");
    expect(releasedLane.match(/Von dir freigegeben am/g)).toHaveLength(2);
    expect(releasedLane).toContain(
      "In Social angekündigt; geht zum Termin raus",
    );
    expect(releasedLane).toContain("social/posts?post=s-fb");
    expect(releasedLane).toContain("social/posts?post=s-ig");
    expect(releasedLane).toContain("In Social öffnen");
    // Two "In Social öffnen" links, told apart by their channel.
    expect(releasedLane).toContain(
      'aria-label="In Social öffnen – @familyplan.app · Instagram"',
    );
    expect(releasedLane).toContain(
      'aria-label="In Social öffnen – FamilyPlan · Facebook"',
    );
    // The post's state, not the content's review status.
    expect(releasedLane.slice(0, releasedLane.indexOf("Verlauf"))).toContain(
      ">Geplant<",
    );
    expect(
      releasedLane.slice(0, releasedLane.indexOf("Verlauf")),
    ).not.toContain(">Geprüft<");
    expect(releasedLane.slice(releasedLane.indexOf("Verlauf"))).toContain(
      ">Veröffentlicht<",
    );
    // Released rows are not open actions: the open lane counts one item.
    expect(html).toMatch(
      /Offene Aktionen<span class="lane-count">\(1\)<\/span>/,
    );
  });

  it("marks the post opened from Social, and says when it is gone", () => {
    seed();
    search.value = "publication=p-ig";
    const html = render(<ApprovalInbox />);
    expect(html).toContain(
      "Das ist der Post, den du aus Social geöffnet hast.",
    );
    expect(html).toContain('id="publication-p-ig"');
    expect(html).toContain("approval-content-item is-focused");
    search.value = "publication=not-here";
    expect(render(<ApprovalInbox />)).toContain(
      "Der aus Social geöffnete Post steht hier nicht mehr",
    );
  });

  it("speaks English too", () => {
    seed();
    search.value = "";
    const html = render(<ApprovalInbox />, { locale: "en" });
    for (const heading of [
      "Open actions",
      "Reviewed, not scheduled",
      "Released &amp; scheduled",
      "History",
    ])
      expect(html).toContain(heading);
    expect(html).toContain("Released by you on");
  });

  it("offers Stop on the released post itself while Orbit still holds it", () => {
    seed();
    search.value = "";
    const upcoming = (id: string, vetoDeadline: string | null) => ({
      id,
      version: 3,
      status: "intent_created",
      reason: null,
      channel: FB,
      channelName: "FamilyPlan",
      scheduledAt: slot,
      vetoDeadline,
      excerpt: "Familienabend planen",
      assignmentId: "a1",
      assignmentName: "Daily social",
      ownerReleased: vetoDeadline === null,
      delivery: "publish",
    });
    answers["/assignment-posts"] = {
      items: [
        upcoming("p-fb", null),
        // A post whose content is not listed keeps its own list.
        upcoming("p-unlisted", new Date(Date.now() + 3_600_000).toISOString()),
      ],
    };
    answers["/assignment-drafts"] = { items: [], history: [] };
    try {
      const html = render(<ApprovalInbox />);
      const released = html.slice(
        html.indexOf("Freigegeben &amp; geplant"),
        html.indexOf("approvals-history-title"),
      );
      const pair = released.slice(released.indexOf(">Familienabend<"));
      // Stop sits under the Facebook version; the owner's release is named once.
      expect(pair).toMatch(/FamilyPlan · Facebook[\s\S]*>Stop</);
      expect(pair.match(/>Stop</g)).toHaveLength(1);
      expect(pair).toContain('aria-label="Stop – FamilyPlan · Facebook"');
      expect(pair).not.toContain("Vom Owner freigegeben – kein Veto-Fenster.");
      // The unlisted one is under "Upcoming posts" with its deadline.
      expect(released).toContain("Anstehende Posts");
      expect(released).toContain("Stop möglich bis");
      expect(released).toMatch(
        /Freigegeben &amp; geplant<span class="lane-count">\(2\)/,
      );
    } finally {
      delete answers["/assignment-posts"];
      delete answers["/assignment-drafts"];
    }
  });
});

describe("open exceptions in words (WP2 D)", () => {
  it("explains the data-class block instead of a raw code and a dash", () => {
    seed();
    search.value = "";
    answers["/exceptions?"] = {
      items: [
        row("exceptions", "x-data", {
          code: "AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA",
          status: "open",
          count: 2,
          lastSeenAt: "2026-11-08T07:46:00.000Z",
        }),
      ],
    };
    const html = render(<ApprovalInbox />);
    expect(html).toContain("KI-Anbieter für Kundendaten nicht erlaubt");
    expect(html).toContain("nur an OpenAI");
    expect(html).toContain("Einstellung öffnen");
    expect(html).toContain('href="/manage/p/p1/ai"');
    // The code stays readable, but only under the technical details.
    const details = html.indexOf("Technische Details");
    expect(details).toBeGreaterThan(-1);
    expect(html.indexOf("AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA")).toBeGreaterThan(
      details,
    );
    expect(html).not.toContain("<p>—</p>");
  });

  it("speaks German for a known code even when the server stored English", () => {
    seed();
    search.value = "";
    answers["/exceptions?"] = {
      items: [
        row("exceptions", "x-queue", {
          code: "POSTIZ_QUEUE_CHECK_FAILED",
          status: "open",
          count: 1354,
          lastSeenAt: "2026-11-07T16:17:00.000Z",
          // As the Postiz queue watch stores it (postiz-queue-watch.ts).
          title: "Orbit cannot read the Postiz queue",
          message:
            "The scheduled Postiz queue check failed. Check that Postiz is reachable and the connector token is valid.",
        }),
      ],
    };
    const html = render(<ApprovalInbox />);
    expect(html).toContain("Orbit kann die Postiz-Warteschlange nicht lesen");
    expect(html).toContain("Prüfen, ob Postiz erreichbar");
    expect(html).toContain('href="/manage/p/p1/integrations"');
    expect(html).not.toContain("Orbit cannot read the Postiz queue");
    expect(html).not.toContain("The scheduled Postiz queue check failed");
    expect(html).toContain("<code>POSTIZ_QUEUE_CHECK_FAILED</code>");
  });

  it("keeps a stored text for a code without its own", () => {
    seed();
    search.value = "";
    answers["/exceptions?"] = {
      items: [
        row("exceptions", "x-custom", {
          code: "SOMETHING_NEW",
          status: "open",
          title: "A server title",
          message: "A server message.",
        }),
      ],
    };
    const html = render(<ApprovalInbox />);
    expect(html).toContain("<strong>A server title</strong>");
    expect(html).toContain("A server message.");
  });

  it("keeps an unknown code as its title", () => {
    seed();
    search.value = "";
    answers["/exceptions?"] = {
      items: [
        row("exceptions", "x-new", { code: "SOMETHING_NEW", status: "open" }),
      ],
    };
    const html = render(<ApprovalInbox />, { locale: "en" });
    expect(html).toContain("<strong>SOMETHING_NEW</strong>");
    expect(html).not.toContain("Technical details");
  });
});

describe("draft decisions in the detail view", () => {
  it("disables reject and discard with the reason while a post holds the draft", () => {
    const content = row("content", "c-fb", { status: "reviewed" }) as never;
    const html = render(
      <DraftDecisionSection
        content={content}
        canDecide
        handedOn
        de
        onDone={() => {}}
      />,
    );
    expect(html).toContain("Dieser Entwurf ist bereits eingeplant.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ablehnen</);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Verwerfen</);
    const free = render(
      <DraftDecisionSection content={content} canDecide de onDone={() => {}} />,
    );
    expect(free).not.toContain("bereits eingeplant");
    expect(free).not.toMatch(/disabled=""/);
  });
});
