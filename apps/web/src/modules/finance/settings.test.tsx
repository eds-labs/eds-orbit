import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { financeText } from "./labels";
import {
  AiExtractionForm,
  bindableMailboxes,
  LoadState,
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
    expect(html).toContain("Used by support");
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

  it("a failed read shows the error with a retry, a pending one a skeleton", () => {
    const failed = renderToStaticMarkup(
      <LoadState
        resources={[
          { loading: false, error: new Error("Request failed"), refresh() {} },
        ]}
      >
        <p>content</p>
      </LoadState>,
    );
    expect(failed).toContain("Request failed");
    expect(failed).toContain("Try again");
    expect(failed).not.toContain("content");
    const loading = renderToStaticMarkup(
      <LoadState resources={[{ loading: true, error: null, refresh() {} }]}>
        <p>content</p>
      </LoadState>,
    );
    expect(loading).toContain("skeleton");
    expect(loading).not.toContain("content");
    const ready = renderToStaticMarkup(
      <LoadState resources={[{ loading: false, error: null, refresh() {} }]}>
        <p>content</p>
      </LoadState>,
    );
    expect(ready).toContain("content");
  });

  it("refuses an AI ceiling above the server maximum of 1000 USD", () => {
    const render = (ceiling: string) =>
      renderToStaticMarkup(
        <AiExtractionForm
          t={financeText("en")}
          enabled={false}
          ceiling={ceiling}
          disabled={false}
          pending={false}
          error={null}
          onToggle={() => {}}
          onCeiling={() => {}}
          onSubmit={() => {}}
        />,
      );
    expect(render("1000")).not.toContain("from 0 to 1000 USD");
    expect(render("1000.01")).toContain("from 0 to 1000 USD");
    expect(render("1000.01")).toContain('disabled=""');
  });
});
