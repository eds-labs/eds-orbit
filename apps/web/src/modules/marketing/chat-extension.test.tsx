import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceContext } from "@/components/workspace-context";
import type { ChatHost } from "@/platform/assistant/extensions";
import { assignmentConfirmRenderer, marketingChat } from "./chat-extension";

const assignment = {
  id: "a1",
  version: 1,
  name: "Two posts a day",
  kind: "standing",
  contentType: "social",
  channels: ["x-int"],
  channelNames: { "x-int": "Synthetic X" },
  schedule: {
    rhythm: "weekly",
    weekdays: [1],
    times: ["10:00"],
    leadMinutes: 360,
  },
  topicFrame: "Beta access",
  image: false,
  styleAssetIds: [],
  vetoMinutes: 180,
  monthlyBudgetMicros: 50_000_000,
  actionRequestId: "r1",
};
const host = (conversation: Record<string, any> | null): ChatHost => ({
  conversation,
  pending: false,
  de: false,
  run: async () => {},
});
const workspace = (children: React.ReactNode) =>
  renderToStaticMarkup(
    <WorkspaceContext.Provider
      value={
        {
          project: { id: "p1" },
          isOwner: true,
          canEdit: true,
          locale: "en",
        } as never
      }
    >
      {children}
    </WorkspaceContext.Provider>,
  );

describe("marketing chat parts", () => {
  it("renders an assignment card from the message and its live state", () => {
    const Card = marketingChat.messageCards!.assignment!;
    const html = workspace(
      <Card
        card={{ kind: "assignment", assignment }}
        host={host({
          assignments: [
            {
              ...assignment,
              status: "draft",
              actionRequest: {
                id: "r1",
                version: 1,
                packageHash: "a".repeat(64),
                status: "pending",
                expiresAt: "2026-10-16T12:00:00.000Z",
              },
            },
          ],
        })}
      />,
    );
    expect(html).toContain("Two posts a day");
    expect(
      workspace(<Card card={{ kind: "assignment" }} host={host(null)} />),
    ).toBe("");
  });

  it("shows persisted output evidence and refreshes running assignments", () => {
    const Card = marketingChat.messageCards!.assignment!;
    const latestRun = {
      id: "run-actual",
      date: "2026-10-20",
      status: "running",
      costMicros: 1200,
      operation: {
        state: "outcome_unknown",
        lifecycle: "running",
        degraded: false,
        complete: true,
        costs: {
          settledMicros: 1200,
          heldMicros: 50000,
          unknownMicros: 70000,
          releasedMicros: 0,
          complete: true,
        },
        recovery: [{ action: "reconcile_outcome", href: "/operations" }],
      },
      blockers: ["REVIEW_PENDING"],
      deliverables: [
        {
          contentId: "content-actual",
          channel: "x-int",
          outcome: "awaiting_owner",
          reason: null,
          publicationId: null,
          postizDraftId: null,
        },
      ],
    };
    const conversation = {
      assignments: [
        { ...assignment, status: "active", actionRequest: null, latestRun },
      ],
    };
    const html = workspace(
      <Card
        card={{ kind: "assignment", assignment }}
        host={host(conversation)}
      />,
    );
    expect(html).toContain("run-actual");
    expect(html).toContain("content-actual");
    expect(html).toContain("REVIEW_PENDING");
    expect(html).toContain("Outcome unknown: reconcile before continuing");
    expect(html).toContain("Unknown cost (reserved exposure)");
    expect(html).toContain("Check outcome; do not resend");
    expect(html).toContain("Awaiting your approval");
    expect(html).toContain("$0.0012");
    expect(html).toContain("/p/p1/approvals");
    expect(marketingChat.busy!(conversation)).toBe(true);
    expect(
      marketingChat.busy!({
        assignments: [{ latestRun: { ...latestRun, status: "done" } }],
      }),
    ).toBe(false);
  });

  it("keeps the chat refreshing only while a package is in progress", () => {
    expect(marketingChat.busy!({ packages: [] })).toBe(false);
    expect(marketingChat.busy!({})).toBe(false);
  });

  it("takes over the inbox only for assignment confirmations with content", () => {
    expect(assignmentConfirmRenderer.accepts({ summary: { assignment } })).toBe(
      true,
    );
    expect(assignmentConfirmRenderer.accepts({ summary: {} })).toBe(false);
  });
});
