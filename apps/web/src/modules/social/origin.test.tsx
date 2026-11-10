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
import { projectHref, routeTable } from "@/platform/shell/routes";
import { PostsView } from "./posts/posts-view";
import { PostDrawer } from "./calendar/drawer";
import { originKind, originView } from "./origin";
import type { CalendarItem } from "./api";

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
const PUBLICATION = "6b0e9a52-2f1c-4c55-9a51-0f0c9f6a1d11";

function render(
  node: React.ReactNode,
  { locale = "de" as Locale, marketing = true, access = "owner" } = {},
) {
  const module = (id: string) => ({
    id,
    access,
    enabled: true,
    nav: [],
    displayName: { en: "", de: "" },
    description: { en: "", de: "" },
  });
  const shell = {
    hrefOf: (key: string) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    modules: [module("social"), ...(marketing ? [module("marketing")] : [])],
    table,
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

const schedule = {
  mode: "at",
  at: "2026-11-09T17:30:00.000Z",
  local: "2026-11-09T18:30",
  timeZone: "Europe/Berlin",
  fold: null,
};
/** The 09.11.2026 case: released by the owner in Marketing, announced in Social. */
const announced = {
  id: "s1",
  status: "scheduled",
  title: null,
  excerpt: "Familienabend planen",
  schedule,
  approvalState: "none",
  origin: "marketing",
  originRef: { module: "marketing", type: "publication", id: PUBLICATION },
  readOnly: true,
  accounts: [{ accountId: "a-fb", platform: "facebook", handle: "FamilyPlan" }],
  publications: { total: 0, published: 0, failed: 0, unknown: 0, test: false },
  version: 2,
  updatedAt: "",
};

describe("where a Social post came from (WP3)", () => {
  it("reads the kind from originRef, else from the origin", () => {
    expect(
      originKind({ origin: "marketing", originRef: announced.originRef }),
    ).toBe("marketing");
    expect(
      originKind({
        origin: "marketing",
        originRef: { module: "marketing", type: "draft_handoff", id: "h" },
      }),
    ).toBe("draft_handoff");
    expect(
      originKind({
        origin: "legacy_postiz",
        originRef: { module: "postiz", type: "postiz_drafts", id: "m" },
      }),
    ).toBe("postiz");
    expect(originKind({ origin: "legacy_postiz" })).toBe("postiz");
    expect(originKind({ origin: "manual", originRef: null })).toBeNull();
    expect(originKind({ origin: "mcp" })).toBeNull();
  });

  it("interprets the native approval only for native decisions", () => {
    // Marketing released it: Social's empty approval is not "unapproved",
    // and the hand-off's approval ("worker") is not shown either.
    for (const approvalState of ["none", "approved"] as const)
      expect(originView({ ...announced, approvalState }, "de")).toEqual({
        origin: "Freigegeben über Marketing",
        approval: null,
        publicationId: PUBLICATION,
      });
    expect(
      originView(
        {
          origin: "marketing",
          originRef: { module: "marketing", type: "draft_handoff", id: "h" },
          approvalState: "pending",
        },
        "de",
      ),
    ).toEqual({
      origin: "Entwurf aus Marketing – Freigabe hier in Social",
      approval: "Freigabe angefragt",
      publicationId: null,
    });
    expect(
      originView({ origin: "legacy_postiz", approvalState: "none" }, "en"),
    ).toEqual({
      origin: "Taken over from Postiz",
      approval: null,
      publicationId: null,
    });
    expect(
      originView(
        { origin: "manual", originRef: null, approvalState: "pending" },
        "en",
      ),
    ).toEqual({
      origin: null,
      approval: "Approval requested",
      publicationId: null,
    });
    expect(
      originView(
        { origin: "manual", originRef: null, approvalState: "none" },
        "en",
      ),
    ).toEqual({ origin: null, approval: null, publicationId: null });
  });

  it("lists the 09.11 post as released through Marketing, with a link to its approval", () => {
    search.value = "";
    answers["/social/posts"] = { items: [announced], nextCursor: null };
    const html = render(<PostsView />);
    expect(html).toContain("Freigegeben über Marketing");
    expect(html).not.toMatch(
      /Wartet auf Freigabe|Freigabe abgelehnt|Freigabe angefragt|nicht freigegeben/i,
    );
    expect(html).toContain(`approvals?publication=${PUBLICATION}`);
    expect(html).toContain("In den Marketing-Freigaben ansehen");
    // Without Marketing for the member, the words stay and the link goes.
    const closed = render(<PostsView />, { marketing: false });
    expect(closed).toContain("Freigegeben über Marketing");
    expect(closed).not.toContain("approvals?publication=");
  });

  it("shows a reader the origin of a held post instead of an approval", () => {
    search.value = "post=s1";
    answers["/social/posts/s1"] = {
      id: "s1",
      status: "scheduled",
      title: null,
      baseText: "Familienabend planen",
      baseMedia: [],
      schedule,
      approval: {
        state: "none",
        requestId: null,
        approvedAt: null,
        approvedBy: null,
      },
      packageHash: null,
      origin: "marketing",
      originRef: announced.originRef,
      readOnly: true,
      version: 2,
      createdAt: "",
      updatedAt: "",
      variants: [],
      publications: [],
    };
    answers["/social/accounts"] = { items: [] };
    answers["/social/media"] = { items: [] };
    const html = render(<PostsView />, { locale: "en" });
    expect(html).toContain("Released through Marketing");
    expect(html).toContain("View in Marketing approvals");
  });

  it("names the origin in the calendar drawer and hides the hand-off's approval", () => {
    answers["/social/posts/s1"] = {
      ...(answers["/social/posts/s1"] as object),
      status: "publishing",
      approval: {
        state: "approved",
        requestId: null,
        approvedAt: "2026-11-09T17:30:00.000Z",
        approvedBy: "worker",
      },
      readOnly: false,
    };
    const item = {
      ...announced,
      projectId: project.id,
    } as unknown as CalendarItem;
    const html = render(
      <PostDrawer
        item={item}
        scope="project"
        onClose={() => {}}
        onMove={() => {}}
      />,
    );
    expect(html).toContain("Freigegeben über Marketing");
    expect(html).not.toContain("worker");
    expect(html).not.toMatch(/>Freigegeben<\/span>/);
  });

  it("keeps a native post's approval words", () => {
    search.value = "";
    answers["/social/posts"] = {
      items: [
        {
          ...announced,
          id: "n1",
          origin: "manual",
          originRef: null,
          approvalState: "pending",
          readOnly: false,
        },
      ],
      nextCursor: null,
    };
    const html = render(<PostsView />, { locale: "en" });
    expect(html).toContain("Approval requested");
    expect(html).not.toContain("Released through Marketing");
  });
});
