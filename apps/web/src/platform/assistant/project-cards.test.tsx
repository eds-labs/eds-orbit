import { beforeEach, describe, expect, it, vi } from "vitest";
const posted = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  post: vi.fn(async (...args: unknown[]) => {
    posted.calls.push(args);
    return {};
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import { webRegistry } from "@/modules/registry";
import { projectAwareHref, routeTable } from "@/platform/shell/routes";
import type { ChatCard, ChatMessage } from "./api";
import { MessageView, StepLines, toolLabel } from "./conversation-view";
import { useDecideActionRequest } from "./decide";
import { AssistantLinkContext, type AssistantLinks } from "./links";
import { ChatCardView, decisionMode } from "./project-cards";

const table = routeTable(webRegistry);
const links: AssistantLinks = {
  hrefFor: (projectId, href) => projectAwareHref(table, projectId, href),
  projectName: (id) => ({ p1: "Alpha", p2: "Beta" })[id],
};
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <AssistantLinkContext.Provider value={links}>
      {node}
    </AssistantLinkContext.Provider>,
  );
const request = {
  id: "ar-1",
  version: 4,
  packageHash: "b".repeat(64),
  decidable: true,
  inline: true,
};
const status = (over: Partial<ChatCard> = {}): ChatCard => ({
  kind: "status",
  label: "Close ticket #101",
  status: "pending",
  projectId: "p2",
  projectName: "Beta",
  actionRequest: request,
  ...over,
});

describe("cards with their project (WP3.8)", () => {
  it("shows the project badge and links into the card's project", () => {
    const html = render(
      <ChatCardView
        de={false}
        card={{
          kind: "link",
          label: "Ticket #101",
          href: "/support/tickets?ticket=t1",
          projectId: "p2",
          projectName: "Beta",
        }}
      />,
    );
    expect(html).toContain('class="project-badge"');
    expect(html).toContain("Beta");
    expect(html).toContain('href="/p/p2/support/tickets?ticket=t1"');
  });

  it("names the project from the member's projects when the card has only its id", () => {
    const html = render(
      <ChatCardView
        de
        card={{ kind: "source", label: "Website", projectId: "p1" }}
      />,
    );
    expect(html).toContain("Alpha");
    expect(html).toContain("Quelle");
  });

  it("resolves legacy paths and keeps pages outside projects", () => {
    expect(projectAwareHref(table, "p2", "/approvals")).toBe("/p/p2/approvals");
    expect(projectAwareHref(table, "p2", "/decisions")).toBe("/p/p2/decisions");
    expect(projectAwareHref(table, "p2", "/account")).toBe("/account");
    expect(projectAwareHref(table, "p2", "/p/p1/assistant")).toBe(
      "/p/p1/assistant",
    );
    expect(projectAwareHref(table, "p2", "https://example.invalid/x")).toBe(
      "https://example.invalid/x",
    );
  });
});

describe("inline decisions (WP3.5)", () => {
  beforeEach(() => {
    posted.calls = [];
  });

  it("offers Approve and Reject only when decidable and inline", () => {
    expect(decisionMode(status())).toBe("inline");
    const html = render(<ChatCardView de={false} card={status()} />);
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).not.toContain("Open approvals");
  });

  it("links to the project's approvals otherwise", () => {
    for (const card of [
      status({ actionRequest: { ...request, decidable: false } }),
      status({ actionRequest: { ...request, inline: false } }),
      status({ kind: "link", actionRequest: request }),
    ]) {
      expect(decisionMode(card)).toBe("link");
      const html = render(<ChatCardView de={false} card={card} />);
      expect(html).not.toContain(">Approve<");
      expect(html).toContain("Open approvals in Beta");
      expect(html).toContain('href="/p/p2/decisions"');
    }
    expect(decisionMode({ kind: "status", label: "x" })).toBeNull();
    expect(
      render(
        <ChatCardView
          de
          card={status({ actionRequest: { ...request, inline: false } })}
        />,
      ),
    ).toContain("Freigaben in Beta öffnen");
  });

  it("decides in the card's project with the exact version and hash", async () => {
    let decide!: ReturnType<typeof useDecideActionRequest>;
    function Probe() {
      decide = useDecideActionRequest("p2");
      return null;
    }
    renderToStaticMarkup(<Probe />);
    await decide(request, "approve");
    await decide(request, "reject");
    expect(posted.calls).toEqual([
      [
        "/projects/p2/action-requests/ar-1/decide",
        { version: 4, packageHash: "b".repeat(64), decision: "approve" },
      ],
      [
        "/projects/p2/action-requests/ar-1/decide",
        { version: 4, packageHash: "b".repeat(64), decision: "reject" },
      ],
    ]);
  });

  it("refuses without a project instead of guessing one", async () => {
    let decide!: ReturnType<typeof useDecideActionRequest>;
    function Probe() {
      decide = useDecideActionRequest();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    await expect(decide(request, "approve")).rejects.toThrow(
      "PROJECT_REQUIRED",
    );
    expect(posted.calls).toEqual([]);
  });
});

describe("messages of personal turns", () => {
  it("renders progress lines from the run's steps", () => {
    const html = renderToStaticMarkup(
      <StepLines
        de={false}
        steps={[
          {
            tool: "support_ticket_list",
            projectName: "Beta",
            state: "finished",
          },
          { tool: "work.task_list", projectName: "Alpha", state: "started" },
          { tool: "finance_documents", state: "failed" },
        ]}
      />,
    );
    expect(html).toContain("Support ticket list · Beta");
    expect(html).toContain("Work task list · Alpha");
    expect(html).toContain(">done<");
    expect(html).toContain(">running<");
    expect(html).toContain(">failed<");
    expect(toolLabel("")).toBe("");
  });

  it("renders a work-order notice with its result cards, each with its project", () => {
    const message: ChatMessage = {
      id: "m1",
      role: "notice",
      text: "",
      notice: { kind: "work_order_finished", text: "5 tickets investigated." },
      cards: [
        {
          kind: "link",
          label: "Ticket #101",
          href: "/support/tickets",
          projectId: "p2",
        },
        {
          kind: "link",
          label: "Ticket #102",
          href: "/support/tickets",
          projectId: "p1",
        },
      ],
    };
    const html = render(<MessageView message={message} de={false} />);
    expect(html).toContain("chat-notice");
    expect(html).toContain("5 tickets investigated.");
    expect(html).toContain("Beta");
    expect(html).toContain("Alpha");
  });
});
