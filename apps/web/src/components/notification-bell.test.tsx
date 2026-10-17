import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import {
  NotificationBell,
  preferencesBody,
  safeLink,
  unreadLabel,
} from "./notification-bell";
import { emailConnectBody } from "./email-connection";

describe("notification bell (WP4.7)", () => {
  // The top bar sits outside the workspace provider; the bell must not need
  // it (the first version did and blanked the whole app in the browser run).
  it("renders without the workspace context", () => {
    expect(() =>
      renderToString(
        <NotificationBell
          project={{ id: "p", timezone: "Europe/Berlin" }}
          locale="de"
        />,
      ),
    ).not.toThrow();
  });
  it("shows a short unread count", () => {
    expect([0, 1, 9, 10, 250].map(unreadLabel)).toEqual([
      "",
      "1",
      "9",
      "9+",
      "9+",
    ]);
  });
  it("follows Orbit paths only", () => {
    expect(safeLink("/projects/p/tasks")).toBe("/projects/p/tasks");
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "/\\evil",
      null,
    ])
      expect(safeLink(bad)).toBeNull();
  });
  it("sends one choice per kind", () => {
    expect(
      preferencesBody([
        { kind: "a_b", label: { en: "A", de: "A" }, inApp: false, email: true },
      ]),
    ).toEqual({ kinds: { a_b: { inApp: false, email: true } } });
  });
});

describe("mailbox form (WP4.7)", () => {
  it("sends ports as numbers and leaves an empty sender name out", () => {
    expect(
      emailConnectBody({
        smtpHost: " smtp.example.com ",
        smtpPort: "587",
        smtpTls: "starttls",
        imapHost: "imap.example.com",
        imapPort: "",
        imapTls: "",
        username: "u",
        fromAddress: "a@example.com",
        fromName: "",
        password: "p",
      }),
    ).toEqual({
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpTls: "starttls",
      imapHost: "imap.example.com",
      imapPort: 993,
      imapTls: "implicit",
      username: "u",
      fromAddress: "a@example.com",
      password: "p",
    });
  });
});
