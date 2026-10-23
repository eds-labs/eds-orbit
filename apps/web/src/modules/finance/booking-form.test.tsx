import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Account, Category, FinanceDocument } from "./api";
import {
  amountMicros,
  BookingForm,
  bookingOf,
  initialForm,
  type BookingLists,
} from "./booking-form";
import { DocumentPreview, duplicateOpen } from "./document";
import { financeText } from "./labels";
import { sortQueue } from "./review";

const t = financeText("en");
const COUNTERPARTY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";

const category: Category = {
  id: CATEGORY,
  name: "Software",
  kind: "expense",
  parentId: null,
  accountId: "a",
  version: 1,
  archivedAt: null,
};
const account: Account = {
  id: ACCOUNT,
  code: "1200",
  name: "Bank",
  type: "asset",
  role: null,
  paymentAccount: true,
  currency: null,
  externalCode: null,
  version: 1,
  archivedAt: null,
};
const lists: BookingLists = {
  counterparties: [
    {
      id: COUNTERPARTY,
      name: "Hosting GmbH",
      taxId: null,
      emailDomains: [],
      defaultCategoryId: null,
      defaultAllocation: null,
      version: 1,
    },
  ],
  categories: [category],
  costCenters: [],
  accounts: [account],
  invoices: [],
};

function doc(
  extraction: Record<string, unknown> = {},
  extra: Partial<FinanceDocument> = {},
): FinanceDocument {
  return {
    id: "doc-1",
    fileId: "file-1",
    source: "upload",
    originalName: "invoice.pdf",
    mimeType: "application/pdf",
    status: "needs_review",
    docType: "invoice",
    extraction: {
      docType: "invoice",
      direction: "payable",
      counterparty: { name: "Hosting GmbH" },
      number: "INV-7",
      issueDate: "2026-10-01",
      dueDate: "2026-10-15",
      currency: "EUR",
      totalMicros: "119000000",
      lines: [
        {
          description: "Server",
          amountMicros: "100000000",
          taxMicros: "19000000",
        },
      ],
      suggestion: {
        counterpartyId: COUNTERPARTY,
        categoryId: CATEGORY,
        source: "history",
      },
      ...extraction,
    },
    confidence: 0.9,
    flags: [],
    duplicateOfId: null,
    rejectionReason: null,
    version: 3,
    createdAt: "2026-10-02T08:00:00.000Z",
    ...extra,
  };
}

function render(
  document: FinanceDocument,
  options: {
    bookError?: string | null;
    duplicateOpen?: boolean;
    canWrite?: boolean;
  } = {},
) {
  return renderToStaticMarkup(
    <BookingForm
      t={t}
      locale="en"
      doc={document}
      lists={lists}
      baseCurrency="USD"
      canWrite={options.canWrite ?? true}
      pending={false}
      bookError={options.bookError ?? null}
      duplicateOpen={options.duplicateOpen ?? false}
      onBook={() => {}}
      onSave={() => {}}
      onCreateCounterparty={async () => undefined}
    />,
  );
}

/** The Book button's markup, or null when there is none. */
const bookButton = (html: string) =>
  /<button[^>]*>Book<\/button>/.exec(html)?.[0] ?? null;

describe("finance booking form", () => {
  it("prefills from the extraction and the suggestions", () => {
    const form = initialForm(doc());
    expect(form).toMatchObject({
      kind: "invoice",
      counterpartyId: COUNTERPARTY,
      currency: "EUR",
      lines: [
        {
          description: "Server",
          amount: "100.00",
          tax: "19.00",
          categoryId: CATEGORY,
        },
      ],
    });
    const html = render(doc());
    expect(html).toContain("Suggested from last booking");
    expect(bookButton(html)).not.toContain("disabled");
  });

  it("booking form asks for a manual rate after FX_RATE_MISSING", () => {
    expect(render(doc())).not.toContain("Rate on the issue date");
    const html = render(doc(), { bookError: "FX_RATE_MISSING" });
    expect(html).toContain("Exchange rate needed");
    expect(html).toContain("Enter USD per 1 EUR");
    expect(html).toContain("Rate on the issue date");
    // The rate is now required before booking again.
    expect(bookButton(html)).toContain('disabled=""');

    const form = { ...initialForm(doc()), rateOverride: "1.083412345678" };
    const { booking } = bookingOf(form, t, { fxMissing: true });
    expect(booking?.rateOverride).toBe("1.083412345678");
    expect(
      bookingOf({ ...form, rateOverride: "1.0000000000001" }, t, {
        fxMissing: true,
      }).booking,
    ).toBeNull();
  });

  it("book is disabled while possible_duplicate is unresolved", () => {
    const flagged = doc({}, { flags: ["possible_duplicate"] });
    expect(duplicateOpen(flagged)).toBe(true);
    expect(duplicateOpen(doc({}, { status: "duplicate" }))).toBe(true);
    expect(duplicateOpen(doc())).toBe(false);
    const html = render(flagged, { duplicateOpen: duplicateOpen(flagged) });
    expect(bookButton(html)).toContain('disabled=""');
    expect(html).toContain("Resolve the duplicate question");
  });

  it("receipt forces payment date = issue date", () => {
    const receipt = doc({ docType: "receipt" });
    const form = {
      ...initialForm(receipt),
      accountId: ACCOUNT,
      paidDate: "2026-10-09",
    };
    expect(form.paid).toBe(true);
    const { booking } = bookingOf(form, t, { fxMissing: false });
    expect(booking?.paid).toEqual({ accountId: ACCOUNT, date: "2026-10-01" });
    const html = render(receipt);
    expect(html).toContain("A receipt is paid on its issue date.");
    const dateInput = /<input id="[^"]*-paid-date"[^>]*>/.exec(html)?.[0];
    expect(dateInput).toContain('readOnly=""');
    expect(dateInput).toContain('value="2026-10-01"');
    // No payment account chosen yet: a receipt cannot be booked without one.
    expect(bookButton(html)).toContain('disabled=""');
  });

  it("viewer sees no Book button", () => {
    const html = render(doc(), { canWrite: false });
    expect(bookButton(html)).toBeNull();
    expect(html).not.toContain("Save draft");
    expect(html).toContain("<fieldset disabled=");
  });

  it("requires an explicit counterparty when nothing was suggested", () => {
    const form = initialForm(doc({ suggestion: { source: "none" } }));
    expect(form.counterpartyId).toBe("");
    expect(bookingOf(form, t, { fxMissing: false }).problems).toContain(
      "Choose or create a counterparty.",
    );
  });

  it("checks amounts against the currency's decimals", () => {
    expect(amountMicros("12.34", "EUR")).toBe(12_340_000n);
    expect(amountMicros("12,5", "EUR")).toBe(12_500_000n);
    expect(amountMicros("12.345", "EUR")).toBeNull();
    expect(amountMicros("12.123456", "USDC")).toBe(12_123_456n);
    expect(amountMicros("12.1234567", "USDC")).toBeNull();
    expect(amountMicros("-1", "EUR")).toBeNull();
  });

  it("warns when the lines do not add up to the total", () => {
    expect(render(doc())).not.toContain("do not add up");
    expect(render(doc({ totalMicros: "120000000" }))).toContain(
      "The lines do not add up to the document total.",
    );
  });

  it("pdf preview always offers a download fallback", () => {
    const html = renderToStaticMarkup(
      <DocumentPreview
        t={t}
        doc={doc()}
        inlineUrl="/api/x/file?disposition=inline"
        downloadUrl="/api/x/file?disposition=attachment"
      />,
    );
    expect(html).toMatch(/<iframe[^>]*sandbox=""/);
    expect(html).toContain('href="/api/x/file?disposition=inline"');
    expect(html).toContain('href="/api/x/file?disposition=attachment"');
    expect(html).toContain(">Open<");
    expect(html).toContain(">Download<");

    const xml = renderToStaticMarkup(
      <DocumentPreview
        t={t}
        doc={doc({}, { mimeType: "application/xml" })}
        inlineUrl="/inline"
        downloadUrl="/download"
      />,
    );
    expect(xml).not.toContain("<iframe");
    expect(xml).not.toContain("/inline");
    expect(xml).toContain('href="/download"');

    const image = renderToStaticMarkup(
      <DocumentPreview
        t={t}
        doc={doc({}, { mimeType: "image/png" })}
        inlineUrl="/inline"
        downloadUrl="/download"
      />,
    );
    expect(image).toContain('<img src="/inline"');
  });

  it("sorts the queue by flag severity, then age", () => {
    const at = (id: string, day: string, extra: Partial<FinanceDocument>) =>
      doc({}, { id, createdAt: `2026-10-${day}T00:00:00.000Z`, ...extra });
    const sorted = sortQueue([
      at("plain-new", "05", {}),
      at("plain-old", "01", { flags: ["low_confidence"] }),
      at("mismatch", "04", { flags: ["total_mismatch"] }),
      at("failed", "06", { status: "failed" }),
      at("dup", "03", { flags: ["possible_duplicate"] }),
    ]);
    expect(sorted.map((d) => d.id)).toEqual([
      "failed",
      "dup",
      "mismatch",
      "plain-old",
      "plain-new",
    ]);
  });
});
