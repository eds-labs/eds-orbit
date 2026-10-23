import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { financeText } from "./labels";
import {
  AiExtractionForm,
  bindableMailboxes,
  MailboxList,
  type EmailMailbox,
} from "./settings";

const mailbox = (
  id: string,
  extra: Record<string, unknown> = {},
): EmailMailbox => ({
  connection: {
    id,
    data: { provider: "email", fromAddress: `${id}@example.com`, ...extra },
  },
  default: false,
  inUse: 0,
  inbound: null,
  lastArchiveError: null,
});

describe("finance settings", () => {
  it("settings shows AI consent off by default", () => {
    const html = renderToStaticMarkup(
      <AiExtractionForm
        t={financeText("en")}
        enabled={false}
        ceiling="2"
        disabled={false}
        pending={false}
        error={null}
        onToggle={() => {}}
        onCeiling={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).not.toContain('checked=""');
    expect(html).toContain("store: false");
    expect(html).toContain("spend mandate");
    expect(html).toContain("Daily ceiling");
  });

  it("disables the consent for members who are not owners", () => {
    const html = renderToStaticMarkup(
      <AiExtractionForm
        t={financeText("de")}
        enabled={true}
        ceiling="2"
        disabled={true}
        pending={false}
        error={null}
        onToggle={() => {}}
        onCeiling={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toContain('checked=""');
    expect(html).toContain('<fieldset disabled="">');
    expect(html).not.toContain('type="submit"');
  });

  it("mailbox section lists only e-mail connections", () => {
    const mailboxes = [
      mailbox("a"),
      mailbox("b", { provider: "postiz", fromAddress: "stray@example.com" }),
      mailbox("c", { ownerModule: "support" }),
    ];
    const rows = bindableMailboxes(mailboxes, []);
    expect(rows.map((r) => r.mailbox.connection.id)).toEqual(["a", "c"]);
    const html = renderToStaticMarkup(
      <MailboxList
        t={financeText("en")}
        rows={rows}
        canManage={true}
        pending={false}
        onBind={() => {}}
        onUnbind={() => {}}
      />,
    );
    expect(html).toContain("a@example.com");
    expect(html).toContain("c@example.com");
    expect(html).not.toContain("stray@example.com");
    // A mailbox another module owns cannot be bound.
    expect(html).toContain("support");
    expect(html.match(/Bind to finance/g)).toHaveLength(1);
  });

  it("shows the archive folder and an error text per code", () => {
    const rows = bindableMailboxes(
      [{ ...mailbox("a"), lastArchiveError: "IMAP_AUTH" }],
      [
        {
          id: "bind1",
          emailConnectionId: "a",
          archiveFolder: "Orbit/Processed",
          active: true,
          version: 1,
          lastArchiveError: "IMAP_AUTH",
        },
      ],
    );
    const html = renderToStaticMarkup(
      <MailboxList
        t={financeText("de")}
        rows={rows}
        canManage={true}
        pending={false}
        onBind={() => {}}
        onUnbind={() => {}}
      />,
    );
    expect(html).toContain("Orbit/Processed");
    expect(html).toContain("Das Postfach hat die Anmeldung abgelehnt");
    expect(html).toContain("Lösen");
  });
});
