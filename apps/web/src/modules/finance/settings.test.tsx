import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { financeText } from "./labels";
import { errorText } from "./lists";
import { rateText } from "./amount";
import {
  AiExtractionForm,
  ArchiveConfirmView,
  ceilingMicros,
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

describe("finance error texts", () => {
  const codes = [
    "FINANCE_ACCOUNT_ARCHIVED",
    "CURRENCY_UNSUPPORTED",
    "FINANCE_BASE_CURRENCY_LOCKED",
    "FINANCE_CURRENCY_IN_USE",
    "EMAIL_MAILBOX_IN_USE",
    "EMAIL_MAILBOX_OWNED",
    "FINANCE_DUPLICATE",
    "FINANCE_IN_USE",
    "VERSION_CONFLICT",
    "FX_RATE_MISSING",
    "FINANCE_EXTRACTION_RUNNING",
    "FINANCE_SETUP_REQUIRED",
  ];

  it("has words for every booking and settings code in en and de", () => {
    for (const locale of ["en", "de"] as const)
      for (const code of codes)
        expect(
          financeText(locale).manage.errors[code],
          `${locale} ${code}`,
        ).toBeTruthy();
  });

  it("a booking error reads as words, not a code", () => {
    expect(
      errorText(
        new ApiError("FINANCE_ACCOUNT_ARCHIVED", 422),
        financeText("en"),
      ),
    ).toBe("An archived account cannot be booked to.");
    expect(errorText(null, financeText("de"))).toBe("Anfrage fehlgeschlagen.");
  });

  it("a settings save error (useMutation's message) reads as words", () => {
    // useMutation keeps the error's message: the code with spaces.
    const message = new ApiError("FINANCE_CURRENCY_IN_USE", 409).message;
    expect(errorText(message, financeText("de"))).toContain(
      "Diese Währung wird noch",
    );
    expect(errorText("SOMETHING ELSE", financeText("en"))).toBe(
      "SOMETHING ELSE",
    );
  });
});

describe("finance settings inputs", () => {
  it("parses the AI ceiling like a USD amount", () => {
    expect(ceilingMicros("2")).toBe(2_000_000);
    expect(ceilingMicros("2.5")).toBe(2_500_000);
    expect(ceilingMicros("2,50")).toBe(2_500_000);
    // "1,000" is never one dollar: as a USD amount it has too many
    // decimals and is refused; grouped with decimals it is a thousand.
    expect(ceilingMicros("1,000")).toBeNull();
    expect(ceilingMicros("1,000.00")).toBe(1_000_000_000);
    expect(ceilingMicros("1.000,00")).toBe(1_000_000_000);
    expect(ceilingMicros("1,000.01")).toBeNull();
    expect(ceilingMicros("0.001")).toBeNull();
    expect(ceilingMicros("abc")).toBeNull();
    expect(ceilingMicros("-1")).toBeNull();
  });

  it("marks a ceiling over the server maximum invalid", () => {
    const html = renderToStaticMarkup(
      <AiExtractionForm
        t={financeText("en")}
        enabled={false}
        ceiling="1,000.50"
        disabled={false}
        pending={false}
        error={null}
        onToggle={() => {}}
        onCeiling={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("takes a comma as the decimal separator of a rate", () => {
    expect(rateText("1,0850")).toBe("1.0850");
    expect(rateText(" 1.0850 ")).toBe("1.0850");
    expect(rateText("0")).toBeNull();
    expect(rateText("1,000.5")).toBeNull();
    expect(rateText("1.0.5")).toBeNull();
  });
});

describe("archiving in settings", () => {
  const view = (confirming: boolean) =>
    renderToStaticMarkup(
      <ArchiveConfirmView
        t={financeText("en")}
        label="Archive"
        name="6100 Travel"
        confirming={confirming}
        pending={false}
        onAsk={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

  it("asks before archiving", () => {
    expect(view(false)).not.toContain("6100 Travel");
    const asking = view(true);
    expect(asking).toContain("Archive 6100 Travel?");
    expect(asking).toContain("Cancel");
  });
});
