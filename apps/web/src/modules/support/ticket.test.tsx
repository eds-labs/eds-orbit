import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineItem } from "./ticket";
import { inboxBody, parseCategories } from "./settings";
import { supportText } from "./labels";

const render = (entry: Parameters<typeof TimelineItem>[0]["entry"]) =>
  renderToStaticMarkup(
    <TimelineItem
      entry={entry}
      t={supportText("de")}
      locale="de"
      timezone="Europe/Berlin"
      projectId="p1"
    />,
  );

describe("support ticket view (WP5.2)", () => {
  it("marks internal notes and shows the delivery state of replies", () => {
    const note = render({
      entry: "message",
      id: "m1",
      kind: "internal_note",
      internal: true,
      bodyText: "Nur intern",
      createdAt: "2026-10-18T08:00:00Z",
      attachments: [],
    });
    // The class token itself, not the kind class "support-message-internal_note".
    const internal = /support-message-internal(?=["\s])/;
    expect(note).toMatch(internal);
    expect(note).toContain("Interne Notiz");
    const reply = render({
      entry: "message",
      id: "m2",
      kind: "agent_reply",
      internal: false,
      bodyText: "Hallo",
      createdAt: "2026-10-18T08:00:00Z",
      deliveryState: "pending",
      attachments: [
        {
          id: "a1",
          fileId: "f1",
          name: "log.txt",
          mime: "text/plain",
          size: 3,
        },
      ],
    });
    expect(reply).not.toMatch(internal);
    expect(reply).toContain("Wartet auf Zustellung");
    expect(reply).toContain('href="/api/projects/p1/files/f1"');
  });

  it("renders events by their label", () => {
    expect(
      render({
        entry: "event",
        id: "e1",
        type: "assignee",
        before: {},
        after: {},
        createdAt: "2026-10-18T08:00:00Z",
      }),
    ).toContain("Zuständigkeit geändert");
  });

  it("parses category lines and builds the inbox body", () => {
    expect(
      parseCategories("billing: Billing\n\nbroken\naccount: Account: Login"),
    ).toEqual([
      { key: "billing", label: "Billing" },
      { key: "account", label: "Account: Login" },
    ]);
    expect(
      inboxBody({
        name: " Desk ",
        email: true,
        widget: true,
        emailAddress: " support@example.invalid ",
        origins: "https://desk.example.invalid\n\n",
        aiMode: "off",
        language: "en",
      }),
    ).toEqual({
      name: "Desk",
      channels: ["email", "widget"],
      emailAddress: "support@example.invalid",
      allowedOrigins: ["https://desk.example.invalid"],
      aiMode: "off",
      language: "en",
    });
    expect(
      inboxBody({
        name: "Mail",
        email: true,
        widget: false,
        emailAddress: "a@example.invalid",
        origins: "https://x.example",
        aiMode: "draft",
        language: "de",
      }).allowedOrigins,
    ).toEqual([]);
  });
});
