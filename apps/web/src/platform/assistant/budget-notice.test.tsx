import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));
import { renderToStaticMarkup } from "react-dom/server";
import type { Identity, Project } from "@/lib/api";
import type { AssistantStatus } from "./api";
import {
  AssistantContext,
  type AssistantContextValue,
} from "./assistant-context";
import { AssistantPanel } from "./assistant-panel";
import { AssistantBudgetNotice, assistantBudgetState } from "./budget-notice";
import type { AssistantConversation } from "./use-assistant-conversation";

const status = (capMicros: number | null): AssistantStatus => ({
  enabled: true,
  workspaceId: "w1",
  personalSpaceId: "space-1",
  capMicros,
  autoMemory: true,
});

const identity = (
  role: string,
  flags: { administration?: boolean; connections?: boolean } = {
    administration: true,
    connections: true,
  },
): Identity => ({
  user: { id: "u1", name: "Member", email: "m@example.invalid" },
  projects: [],
  workspaces: [
    {
      id: "w1",
      name: "Org",
      role,
      canManage: role === "owner" && flags.administration === true,
    },
  ],
  ...flags,
});

describe("assistantBudgetState (WP2 A)", () => {
  it("blocks without a cap or with a cap of 0, never with a positive cap", () => {
    expect(assistantBudgetState(status(5_000_000), identity("member"))).toEqual({
      blocked: false,
    });
    expect(assistantBudgetState(status(null), identity("member"))).toMatchObject({
      blocked: true,
      reason: "not_set",
    });
    expect(assistantBudgetState(status(0), identity("member"))).toMatchObject({
      blocked: true,
      reason: "zero",
    });
    // A member without the assistant gets the disabled notice instead.
    expect(
      assistantBudgetState(
        { enabled: false, workspaceId: "w1", reason: "ASSISTANT_ENTITLEMENT" },
        identity("owner"),
      ),
    ).toEqual({ blocked: false });
    expect(assistantBudgetState(null, null)).toEqual({ blocked: false });
  });

  it("links organization owners to the anchored cap when both flags are on", () => {
    expect(assistantBudgetState(status(null), identity("owner"))).toEqual({
      blocked: true,
      reason: "not_set",
      audience: "owner",
      href: "/o/w1/settings#assistant-budget",
    });
  });

  it("tells an owner the setting is not available while a flag is off", () => {
    for (const flags of [
      { administration: false, connections: true },
      { administration: true, connections: false },
      { administration: false, connections: false },
    ]) {
      const state = assistantBudgetState(status(null), identity("owner", flags));
      expect(state).toMatchObject({ audience: "owner_unavailable" });
      expect(state.blocked && state.href).toBeFalsy();
    }
  });

  it("sends members and project owners to an organization owner", () => {
    expect(
      assistantBudgetState(status(null), identity("member")),
    ).toMatchObject({ audience: "member" });
    // Owning a project is not owning the organization.
    const projectOwner: Identity = {
      ...identity("member"),
      projects: [{ id: "p1", name: "FamilyPlan", role: "owner" } as never],
    };
    expect(assistantBudgetState(status(0), projectOwner)).toMatchObject({
      audience: "member",
    });
  });
});

describe("AssistantBudgetNotice", () => {
  it("says project budgets do not apply and who sets it, in both languages", () => {
    const member = renderToStaticMarkup(
      <AssistantBudgetNotice
        state={{ blocked: true, reason: "not_set", audience: "member" }}
        de
      />,
    );
    expect(member).toContain(
      "Persönliches Assistentenbudget der Organisation nicht gesetzt",
    );
    expect(member).toContain("nicht aus Projektbudgets");
    expect(member).toContain("Bitte einen Owner deiner Organisation");
    expect(member).not.toContain("href=");
    const owner = renderToStaticMarkup(
      <AssistantBudgetNotice
        state={{
          blocked: true,
          reason: "zero",
          audience: "owner",
          href: "/o/w1/settings#assistant-budget",
        }}
        de={false}
        onRefresh={() => {}}
      />,
    );
    expect(owner).toContain("The assistant budget per member is set to USD 0");
    expect(owner).toContain('href="/o/w1/settings#assistant-budget"');
    expect(owner).toContain("Set the assistant budget");
    expect(owner).toContain("Check again");
    const off = renderToStaticMarkup(
      <AssistantBudgetNotice
        state={{ blocked: true, reason: "not_set", audience: "owner_unavailable" }}
        de={false}
      />,
    );
    expect(off).toContain("not available on this installation");
  });
});

describe("the panel without a cap", () => {
  const conversation = {
    base: "/projects/space-1/chat",
    projectId: "space-1",
    conversationId: "",
    activeRunId: "",
    stream: null,
    pending: false,
    error: "",
    busy: false,
    history: {
      items: [],
      loading: false,
      error: null,
      hasOlder: false,
      showArchived: false,
      setShowArchived: () => {},
      loadOlder: async () => {},
    },
    detail: { data: null, loading: false, error: null },
  } as unknown as AssistantConversation;
  const context = (over: Partial<AssistantContextValue>): AssistantContextValue => ({
    available: true,
    enabled: true,
    status: status(null),
    conversation,
    locale: "en",
    isOpen: true,
    openPanel: () => {},
    closePanel: () => {},
    focusProjectId: "",
    setFocusProjectId: () => {},
    projects: [{ id: "p1", name: "Alpha", workspaceId: "w1" } as Project],
    input: "Hello",
    setInput: () => {},
    bubbleHidden: false,
    setBubbleHidden: () => {},
    unseen: false,
    ...over,
  });

  it("shows the notice before sending and blocks the composer", () => {
    const html = renderToStaticMarkup(
      <AssistantContext.Provider value={context({ identity: identity("member") })}>
        <AssistantPanel aboveNav={false} returnFocus={{ current: null }} />
      </AssistantContext.Provider>,
    );
    expect(html).toContain("The organization&#x27;s personal assistant budget is not set");
    expect(html).toContain("Ask an owner of your organization");
    expect(html).toMatch(/<textarea[^>]*id="assistant-panel-input"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("keeps the composer open with a cap", () => {
    const html = renderToStaticMarkup(
      <AssistantContext.Provider
        value={context({ status: status(5_000_000), identity: identity("owner") })}
      >
        <AssistantPanel aboveNav={false} returnFocus={{ current: null }} />
      </AssistantContext.Provider>,
    );
    expect(html).not.toContain("assistant budget is not set");
    expect(html).not.toMatch(/<textarea[^>]*id="assistant-panel-input"[^>]*disabled=""/);
  });
});
