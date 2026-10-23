import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Account, Category, FinanceDocument } from "./api";
import {
  amountMicros,
  BookingForm,
  bookingOf,
  bookingReducer,
  draftPatchOf,
  initialForm,
  type BookingLists,
} from "./booking-form";
import {
  DocumentPreview,
  duplicateOpen,
  formKey,
  mergeSaved,
  SHOWN_START,
  shownReducer,
  withCreated,
} from "./document";
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
    expect(amountMicros("1,000.50", "EUR")).toBe(1_000_500_000n);
    expect(amountMicros("1.000,50", "EUR")).toBe(1_000_500_000n);
    expect(amountMicros("1,234,567", "EUR")).toBe(1_234_567_000_000n);
    expect(amountMicros("1,2,3", "EUR")).toBeNull();
  });

  it("rejects a lone comma before three digits for USDC like the server", () => {
    expect(amountMicros("1,000", "USDC")).toBeNull();
    expect(amountMicros("1.234,567", "USDC")).toBeNull();
    expect(amountMicros("1,5", "USDC")).toBe(1_500_000n);
    expect(amountMicros("1,000.50", "USDC")).toBe(1_000_500_000n);
    expect(amountMicros("1.000", "USDC")).toBe(1_000_000n);
    // Sent as a plain decimal, never with grouping.
    const form = {
      ...initialForm(doc({ currency: "USDC" })),
      lines: [
        {
          description: "Credits",
          amount: "1,000.50",
          tax: "0",
          categoryId: CATEGORY,
          allocation: [],
        },
      ],
    };
    expect(
      bookingOf(form, t, { fxMissing: false }).booking?.lines[0],
    ).toMatchObject({ amount: "1000.500000", tax: "0.000000" });
    expect(draftPatchOf(form).lines).toMatchObject([{ amount: "1000.500000" }]);
  });

  it("selects a counterparty created inline and keeps the other fields", () => {
    const start = {
      ...initialForm(doc({ suggestion: { source: "none" } })),
      paid: true,
      accountId: ACCOUNT,
      paidDate: "2026-10-05",
      rateOverride: "1.08",
      creditsInvoiceId: "inv-1",
      counterpartyId: "__new",
    };
    const next = bookingReducer(start, {
      type: "counterpartyCreated",
      id: COUNTERPARTY,
    });
    expect(next).toEqual({ ...start, counterpartyId: COUNTERPARTY });
    const created = { ...lists.counterparties[0]!, id: "new-1", name: "New" };
    expect(
      withCreated(lists.counterparties, [
        created,
        lists.counterparties[0]!,
      ]).map((c) => c.id),
    ).toEqual([COUNTERPARTY, "new-1"]);
  });

  it("forces a receipt to be paid through the reducer", () => {
    const form = { ...initialForm(doc()), paid: false };
    expect(
      bookingReducer(form, { type: "set", change: { kind: "receipt" } }).paid,
    ).toBe(true);
  });

  it("a saved draft takes the new version and keeps the history", () => {
    const detail = {
      ...doc(),
      revisions: [
        {
          id: "r1",
          version: 3,
          actorUserId: null,
          changes: {},
          createdAt: "2026-10-02T09:00:00.000Z",
        },
      ],
      invoices: [],
    };
    const saved = mergeSaved(detail, {
      ...doc({ number: "INV-8" }),
      version: 4,
    });
    expect(saved.version).toBe(4);
    expect(saved.revisions).toHaveLength(1);
    expect((saved.extraction as { number: string }).number).toBe("INV-8");
  });

  it("a reload after a conflict seeds the form from the fresh document", () => {
    const detail = (number: string, version: number) => ({
      ...doc({ number }, { version }),
      revisions: [],
      invoices: [],
    });
    let shown = shownReducer(SHOWN_START, {
      type: "loaded",
      doc: detail("INV-7", 3),
    });
    const first = formKey(shown.doc!, shown.seed);
    // The person's own save keeps the form (same key, new version).
    shown = shownReducer(shown, {
      type: "saved",
      doc: doc({ number: "INV-7b" }, { version: 4 }),
    });
    expect(shown.doc!.version).toBe(4);
    expect(formKey(shown.doc!, shown.seed)).toBe(first);
    // A refetch without Reload (after Book) keeps it too.
    shown = shownReducer(shown, { type: "loaded", doc: detail("INV-7b", 4) });
    expect(formKey(shown.doc!, shown.seed)).toBe(first);
    // Reload: the next loaded detail gets a new key and seeds a new form.
    shown = shownReducer(shown, { type: "reload" });
    expect(formKey(shown.doc!, shown.seed)).toBe(first);
    shown = shownReducer(shown, { type: "loaded", doc: detail("INV-9", 6) });
    expect(formKey(shown.doc!, shown.seed)).not.toBe(first);
    expect(shown.reseed).toBe(false);
    expect(initialForm(shown.doc!).number).toBe("INV-9");
    expect(shown.doc!.version).toBe(6);
  });

  it("a completed retry reseeds the form", () => {
    let shown = shownReducer(SHOWN_START, {
      type: "loaded",
      doc: { ...doc({}, { status: "failed" }), revisions: [], invoices: [] },
    });
    const before = formKey(shown.doc!, shown.seed);
    shown = shownReducer(shown, {
      type: "replaced",
      doc: doc({ number: "NEW" }, { status: "received", version: 4 }),
    });
    expect(formKey(shown.doc!, shown.seed)).not.toBe(before);
    expect(shown.doc!.status).toBe("received");
  });

  it("Book is a plain button, so Enter in a field does not book", () => {
    expect(bookButton(render(doc()))).toContain('type="button"');
    expect(render(doc())).not.toContain('type="submit"');
  });

  it("names the specific allocation problem", () => {
    const form = initialForm(doc());
    const withRows = (
      allocation: { costCenterId: string; percent: string }[],
    ) =>
      bookingOf({ ...form, lines: [{ ...form.lines[0]!, allocation }] }, t, {
        fxMissing: false,
      }).problems;
    expect(withRows([{ costCenterId: "", percent: "100" }])).toContain(
      "Line 1: Choose a cost center for every share.",
    );
    expect(
      withRows([
        { costCenterId: "a", percent: "50" },
        { costCenterId: "a", percent: "50" },
      ]),
    ).toContain("Line 1: Each cost center can appear once.");
    expect(withRows([{ costCenterId: "a", percent: "1.234" }])).toContain(
      "Line 1: Enter shares as percentages with up to two decimals.",
    );
    expect(withRows([{ costCenterId: "a", percent: "90" }])).toContain(
      "Line 1: The shares must add up to 100.00 %.",
    );
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
