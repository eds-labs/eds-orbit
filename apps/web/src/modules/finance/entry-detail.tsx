"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { useResource } from "@/lib/api";
import { Alert, Badge, Button, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { ResourceError } from "@/platform/ui/collection";
import {
  financeApi,
  financePath,
  type Account,
  type InvoiceDetail,
  type JournalEntry,
} from "./api";
import type { FinanceText } from "./labels";
import { formatMoney } from "./money";
import { DetailBack, useDetailFocus } from "./detail-head";
import { ReasonDialog } from "./void-dialog";

// One journal entry (spec §9): its lines with the original amount, the rate
// and the amount in the base currency, the links to the original document
// and the invoice, and the corrections. Only a manual entry is reversed
// here; an entry posted by an invoice or a payment is corrected by voiding
// that invoice or payment, which keeps statuses and allocations consistent.

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

/** Reverse is offered only for a manual entry that is not a reversal and not yet reversed. */
export const canReverse = (
  entry: Pick<JournalEntry, "sourceType" | "kind" | "reversedById">,
) =>
  entry.sourceType === "manual" &&
  entry.kind !== "reversal" &&
  !entry.reversedById;

const WHOLE = /^-?\d+$/;

/** The entry's amount: the sum of its debit lines in base, or null when unreadable. */
export function entryTotal(entry: Pick<JournalEntry, "lines">): string | null {
  let sum = 0n;
  for (const line of entry.lines) {
    if (!WHOLE.test(line.baseAmountMicros)) return null;
    if (line.side === "debit") sum += BigInt(line.baseAmountMicros);
  }
  return sum.toString();
}

/** The invoice behind an invoice-sourced entry: its status, and the void action. */
function InvoiceSection({
  t,
  invoiceId,
  canWrite,
  onVoid,
}: {
  t: FinanceText;
  invoiceId: string;
  canWrite: boolean;
  onVoid: (invoice: InvoiceDetail) => void;
}) {
  const d = t.entries.detail;
  const { project } = useWorkspace();
  const invoicesHref = `${useShell().hrefOf("finance")}/invoices`;
  const invoice = useResource<InvoiceDetail>(
    financePath(project.id, `/invoices/${encodeURIComponent(invoiceId)}`),
  );
  if (invoice.loading) return <Skeleton />;
  if (invoice.error || !invoice.data)
    return <ResourceError error={invoice.error} retry={invoice.refresh} />;
  const inv = invoice.data;
  return (
    <>
      <AppLink
        className="text-link"
        href={`${invoicesHref}?invoice=${encodeURIComponent(inv.id)}`}
      >
        {inv.number
          ? fill(d.invoice, { number: inv.number })
          : d.invoiceUnnumbered}
      </AppLink>
      {inv.status === "void" ? (
        <Badge tone="neutral">{d.invoiceVoid}</Badge>
      ) : (
        canWrite && (
          <Button variant="outline" size="sm" onClick={() => onVoid(inv)}>
            {d.voidInvoice}
          </Button>
        )
      )}
    </>
  );
}

type Dialog =
  | { type: "reverse" }
  | { type: "voidInvoice"; invoice: InvoiceDetail }
  | { type: "voidPayment" };

export function EntryDetail({
  t,
  locale,
  entry,
  accounts,
  baseCurrency,
  numberOf,
  canWrite,
  onClose,
  onChanged,
}: {
  t: FinanceText;
  locale: string;
  entry: JournalEntry;
  accounts: readonly Account[];
  baseCurrency: string;
  /** The number of another entry in the list, when it is loaded. */
  numberOf: (id: string) => string | null;
  canWrite: boolean;
  onClose: () => void;
  onChanged: (notice: string) => void;
}) {
  const d = t.entries.detail;
  const { project } = useWorkspace();
  const finance = financeApi(project.id);
  const financeHref = useShell().hrefOf("finance");
  const reviewHref = `${financeHref}/review`;
  const invoicesHref = `${financeHref}/invoices`;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const heading = useDetailFocus(true);
  // Bumped after a void, so the invoice section loads the invoice again.
  const [revision, setRevision] = useState(0);
  const account = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.code} · ${a.name}` : "—";
  };
  const kind = t.entries.kinds[entry.kind] ?? entry.kind;
  const done = (notice: string) => {
    setDialog(null);
    setRevision((n) => n + 1);
    onChanged(notice);
  };
  const reversedBy = entry.reversedById
    ? (numberOf(entry.reversedById) ?? "—")
    : null;
  const reverses = entry.reversalOfId
    ? (numberOf(entry.reversalOfId) ?? "—")
    : null;
  const correctedByVoid =
    entry.sourceType === "invoice" || entry.sourceType === "payment";
  return (
    <article
      className="panel finance-detail"
      aria-label={fill(d.title, { number: entry.number })}
    >
      <DetailBack label={t.manage.back} onBack={onClose} />
      <div className="panel-head">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {fill(d.title, { number: entry.number })}
          </h2>
          <p className="finance-detail-meta">
            <Badge>{kind}</Badge>
            <span>{entry.entryDate.slice(0, 10)}</span>
            {entry.reversedById && (
              <Badge tone="warning">{t.entries.reversedBadge}</Badge>
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.manage.close}
          onClick={onClose}
        >
          <X aria-hidden size={16} />
        </Button>
      </div>
      <div className="finance-body">
        <p>{entry.memo ?? d.noMemo}</p>
        <div
          className="table-wrap"
          role="region"
          aria-label={d.lines}
          tabIndex={0}
        >
          <table className="finance-table">
            <thead>
              <tr>
                <th scope="col">{d.account}</th>
                <th scope="col">{d.side}</th>
                <th scope="col">{d.original}</th>
                <th scope="col">{d.rate}</th>
                <th scope="col">{d.rateDate}</th>
                <th scope="col">{d.rateSource}</th>
                <th scope="col">{fill(d.base, { base: baseCurrency })}</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((line) => (
                <tr key={line.id}>
                  <th scope="row">{account(line.accountId)}</th>
                  <td>{line.side === "debit" ? d.debit : d.credit}</td>
                  <td className="finance-num">
                    {formatMoney(line.amountMicros, line.currency, locale)}
                  </td>
                  <td className="finance-num">{line.fxRate || "—"}</td>
                  <td>{line.rateDate ? line.rateDate.slice(0, 10) : "—"}</td>
                  <td>
                    {d.sources[line.rateSource] ?? (line.rateSource || "—")}
                  </td>
                  <td className="finance-num">
                    {formatMoney(line.baseAmountMicros, baseCurrency, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="finance-links">
          {entry.documentId && (
            <li>
              <AppLink
                className="text-link"
                href={`${reviewHref}?document=${encodeURIComponent(entry.documentId)}`}
              >
                {d.document}
              </AppLink>
            </li>
          )}
          {entry.sourceType === "invoice" && entry.sourceId && (
            <li className="finance-link-row">
              <InvoiceSection
                key={revision}
                t={t}
                invoiceId={entry.sourceId}
                canWrite={canWrite}
                onVoid={(invoice) =>
                  setDialog({ type: "voidInvoice", invoice })
                }
              />
            </li>
          )}
          {entry.sourceType === "payment" && entry.sourceId && (
            <li className="finance-link-row">
              <span>{d.paymentSource}</span>
              {(entry.paymentInvoices ?? []).map((inv) => (
                <AppLink
                  key={inv.id}
                  className="text-link"
                  href={`${invoicesHref}?invoice=${encodeURIComponent(inv.id)}`}
                >
                  {inv.number
                    ? fill(d.paymentInvoice, { number: inv.number })
                    : d.invoiceUnnumbered}
                </AppLink>
              ))}
              {canWrite && !entry.reversedById && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDialog({ type: "voidPayment" })}
                >
                  {d.voidPayment}
                </Button>
              )}
            </li>
          )}
          {reverses && <li>{fill(d.reverses, { number: reverses })}</li>}
          {reversedBy && <li>{fill(d.reversedBy, { number: reversedBy })}</li>}
        </ul>
        {correctedByVoid && <p className="panel-note">{d.voidHint}</p>}

        {canWrite && canReverse(entry) && (
          <div className="finance-detail-actions">
            <Button
              variant="outline"
              onClick={() => setDialog({ type: "reverse" })}
            >
              {d.reverse}
            </Button>
          </div>
        )}
        {!canWrite && <Alert kind="info">{t.manage.readOnly}</Alert>}
      </div>

      {dialog?.type === "reverse" && (
        <ReasonDialog
          t={t}
          title={fill(d.reverseTitle, { number: entry.number })}
          body={d.reverseBody}
          confirmLabel={d.reverse}
          run={(reason) => finance.entries.reverse(entry.id, { reason })}
          onDone={() => done(d.reverseDone)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "voidInvoice" && (
        <ReasonDialog
          t={t}
          title={d.voidInvoiceTitle}
          body={d.voidInvoiceBody}
          confirmLabel={d.voidInvoice}
          run={(reason) =>
            finance.invoices.void(dialog.invoice.id, {
              version: dialog.invoice.version,
              reason,
            })
          }
          onDone={() => done(d.voided)}
          onClose={() => setDialog(null)}
          onStale={() => setRevision((n) => n + 1)}
        />
      )}
      {dialog?.type === "voidPayment" && entry.sourceId && (
        <ReasonDialog
          t={t}
          title={d.voidPaymentTitle}
          body={d.voidPaymentBody}
          confirmLabel={d.voidPayment}
          run={(reason) => finance.payments.void(entry.sourceId!, { reason })}
          onDone={() => done(d.voided)}
          onClose={() => setDialog(null)}
        />
      )}
    </article>
  );
}
