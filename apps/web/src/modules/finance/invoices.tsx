"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Skeleton,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { useShell } from "@/platform/shell/shell-context";
import { cn } from "@/lib/utils";
import {
  financeApi,
  financePath,
  query,
  type Invoice,
  type InvoiceDetail,
} from "./api";
import { useFinanceAccess } from "./access";
import { paramsHref } from "./entries";
import { financeText, type FinanceText } from "./labels";
import { useLast, useMasterData } from "./lists";
import { formatMoney } from "./money";
import { payable, PaymentFormView, sameSettlement } from "./payment-form";
import { DetailBack, useDetailFocus } from "./detail-head";
import { ReasonDialog } from "./void-dialog";

// Invoices, receipts and credit notes with what is still open (spec §9).
// Direction, status and the open invoice live in the URL, so the attention
// link `?status=overdue` opens the overdue ones. "Overdue" is derived by the
// server. Payments are recorded for the selected open invoices; voiding an
// invoice or a payment asks for a reason first.

export const DIRECTIONS = ["payable", "receivable"] as const;
export const STATUSES = [
  "open",
  "partially_paid",
  "paid",
  "void",
  "overdue",
] as const;
const LIMIT = 500;

export type InvoiceFilters = { direction: string; status: string };

/** The filters named in the URL; unknown values are dropped. */
export function invoiceFilters(
  params: Pick<URLSearchParams, "get"> | null,
): InvoiceFilters {
  const direction = params?.get("direction") ?? "";
  const status = params?.get("status") ?? "";
  return {
    direction: DIRECTIONS.find((d) => d === direction) ?? "",
    status: STATUSES.find((s) => s === status) ?? "",
  };
}

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (out, [key, value]) => out.replace(`{${key}}`, () => value),
    text,
  );

const statusTone = (status: string) =>
  status === "overdue"
    ? "danger"
    : status === "paid"
      ? "success"
      : status === "partially_paid"
        ? "warning"
        : "neutral";

/** What a credit note credits, as text. */
function creditsText(
  t: FinanceText,
  invoice: Invoice,
  all: readonly Invoice[],
) {
  if (invoice.kind !== "credit_note" || !invoice.creditsInvoiceId) return null;
  const target = all.find((i) => i.id === invoice.creditsInvoiceId);
  return target?.number
    ? fill(t.invoices.credits, { number: target.number })
    : t.invoices.creditsOther;
}

type Dialog =
  | { type: "voidInvoice"; invoice: InvoiceDetail }
  | { type: "voidPayment"; paymentId: string };

/** The open invoice: totals, payments and the correction actions. */
function InvoiceDetailPanel({
  t,
  locale,
  invoiceId,
  counterparty,
  canWrite,
  onClose,
  onChanged,
}: {
  t: FinanceText;
  locale: string;
  invoiceId: string;
  counterparty: string;
  canWrite: boolean;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const v = t.invoices;
  const { project } = useWorkspace();
  const finance = financeApi(project.id);
  const reviewHref = `${useShell().hrefOf("finance")}/review`;
  const detail = useResource<InvoiceDetail>(
    financePath(project.id, `/invoices/${encodeURIComponent(invoiceId)}`),
  );
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const invoice = useLast(detail.data);
  const heading = useDetailFocus(Boolean(invoice));
  if (!invoice)
    return detail.error ? (
      <ResourceError error={detail.error} retry={detail.refresh} />
    ) : (
      <Skeleton />
    );
  const done = (message: string) => {
    setDialog(null);
    detail.refresh();
    onChanged(message);
  };
  const isReceipt = invoice.kind === "receipt";
  return (
    <article
      className="panel finance-detail"
      aria-label={invoice.number ?? v.detail}
    >
      <DetailBack label={t.manage.back} onBack={onClose} />
      <div className="panel-head">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {invoice.number ?? v.unnumbered}
          </h2>
          <p className="finance-detail-meta">
            <Badge>{v.kinds[invoice.kind] ?? invoice.kind}</Badge>
            <Badge tone={statusTone(invoice.displayStatus)}>
              {v.statuses[invoice.displayStatus] ?? invoice.displayStatus}
            </Badge>
            <span>{counterparty}</span>
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
        <dl className="finance-sums">
          <div>
            <dt>{v.totalNet}</dt>
            <dd>{formatMoney(invoice.netMicros, invoice.currency, locale)}</dd>
          </div>
          <div>
            <dt>{v.totalTax}</dt>
            <dd>{formatMoney(invoice.taxMicros, invoice.currency, locale)}</dd>
          </div>
          <div>
            <dt>{v.columns.total}</dt>
            <dd>
              {formatMoney(invoice.totalMicros, invoice.currency, locale)}
            </dd>
          </div>
          <div>
            <dt>{v.columns.open}</dt>
            <dd>
              {invoice.openAmountMicros === null
                ? "—"
                : formatMoney(
                    invoice.openAmountMicros,
                    invoice.currency,
                    locale,
                  )}
            </dd>
          </div>
        </dl>
        {invoice.documentId && (
          <p>
            <AppLink
              className="text-link"
              href={`${reviewHref}?document=${encodeURIComponent(invoice.documentId)}`}
            >
              {v.document}
            </AppLink>
          </p>
        )}
        <h3>{v.payments}</h3>
        {invoice.allocations.length === 0 ? (
          <p className="panel-note">{v.noPayments}</p>
        ) : (
          <ul className="settings-rows">
            {invoice.allocations.map((a, index) => (
              <li key={a.id} className="finance-link-row">
                <span>
                  {fill(v.paymentLine, { n: String(index + 1) })}:{" "}
                  {a.voidedAt ? (
                    <>
                      <s>
                        {formatMoney(a.amountMicros, invoice.currency, locale)}
                      </s>{" "}
                      <Badge tone="neutral">{v.voided}</Badge>
                    </>
                  ) : (
                    formatMoney(a.amountMicros, invoice.currency, locale)
                  )}
                </span>
                {canWrite &&
                  !isReceipt &&
                  !a.voidedAt &&
                  invoice.status !== "void" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDialog({
                          type: "voidPayment",
                          paymentId: a.paymentId,
                        })
                      }
                    >
                      {v.voidPayment}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
        )}
        {canWrite && invoice.status !== "void" && (
          <div className="finance-detail-actions">
            <Button
              variant="outline"
              onClick={() => setDialog({ type: "voidInvoice", invoice })}
            >
              {v.voidInvoice}
            </Button>
          </div>
        )}
      </div>
      {dialog?.type === "voidInvoice" && (
        <ReasonDialog
          t={t}
          title={v.voidInvoiceTitle}
          body={v.voidInvoiceBody}
          confirmLabel={v.voidInvoice}
          run={(reason) =>
            finance.invoices.void(dialog.invoice.id, {
              version: dialog.invoice.version,
              reason,
            })
          }
          onDone={() => done(v.voidDone)}
          onClose={() => setDialog(null)}
          onStale={detail.refresh}
        />
      )}
      {dialog?.type === "voidPayment" && (
        <ReasonDialog
          t={t}
          title={v.voidPaymentTitle}
          body={v.voidPaymentBody}
          confirmLabel={v.voidPayment}
          run={(reason) => finance.payments.void(dialog.paymentId, { reason })}
          onDone={() => done(v.voidDone)}
          onClose={() => setDialog(null)}
        />
      )}
    </article>
  );
}

export function FinanceInvoices() {
  const { project, locale, t: word } = useWorkspace();
  const t = financeText(locale);
  const v = t.invoices;
  const { write } = useFinanceAccess();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const params = useSearchParams();
  const filters = invoiceFilters(params);
  const selected = params?.get("invoice") ?? null;
  const master = useMasterData(project.id);
  const list = useResource<{ items: Invoice[] }>(
    financePath(
      project.id,
      `/invoices${query({
        direction: filters.direction,
        status: filters.status,
        limit: LIMIT,
      })}`,
    ),
  );
  const items = useLast(list.data)?.items ?? null;
  const [picked, setPicked] = useState<string[]>([]);
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const navigate = (change: Record<string, string | null>) =>
    router.replace(paramsHref(pathname, params, change));
  const baseCurrency = master.settings?.baseCurrency ?? "USD";
  const names = new Map(master.counterparties.map((c) => [c.id, c.name]));
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? "—") : "—");
  const chosen = (items ?? []).filter(
    (i) => picked.includes(i.id) && payable(i),
  );
  const together = sameSettlement(chosen);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const refresh = () => list.refresh();

  return (
    <>
      <PageHead
        title={v.title}
        description={v.intro}
        eyebrow={word("moduleEyebrow")}
      />
      {notice && <Alert kind="success">{notice}</Alert>}
      {paying && chosen.length > 0 && (
        <section className="panel" aria-label={t.payment.title}>
          <div className="panel-head">
            <h2>{t.payment.title}</h2>
          </div>
          <div className="finance-body">
            <PaymentFormView
              key={chosen.map((i) => i.id).join(",")}
              t={t}
              locale={locale}
              invoices={chosen}
              accounts={master.accounts}
              baseCurrency={baseCurrency}
              onCancel={() => setPaying(false)}
              onDone={() => {
                setPaying(false);
                setPicked([]);
                setNotice(t.payment.done);
                refresh();
              }}
            />
          </div>
        </section>
      )}
      <div className={cn("finance-review", selected && "finance-review-open")}>
        <section className="panel finance-queue" aria-label={v.list}>
          <div className="panel-head">
            <h2>{v.list}</h2>
            {write && (
              <div className="finance-noprint">
                <Button
                  disabled={chosen.length === 0 || !together || paying}
                  onClick={() => setPaying(true)}
                >
                  {v.recordPayment}
                  {chosen.length > 0
                    ? ` (${fill(v.selected, { n: String(chosen.length) })})`
                    : ""}
                </Button>
              </div>
            )}
          </div>
          <form
            className="finance-filters"
            role="search"
            aria-label={t.entries.filters}
            onSubmit={(ev) => ev.preventDefault()}
          >
            <label>
              <span>{v.direction}</span>
              <select
                id="finance-invoices-direction"
                className="input"
                value={filters.direction}
                onChange={(ev) => navigate({ direction: ev.target.value })}
              >
                <option value="">{v.all}</option>
                {DIRECTIONS.map((d) => (
                  <option key={d} value={d}>
                    {v.directions[d]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{v.status}</span>
              <select
                id="finance-invoices-status"
                className="input"
                value={filters.status}
                onChange={(ev) => navigate({ status: ev.target.value })}
              >
                <option value="">{v.all}</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {v.statuses[s]}
                  </option>
                ))}
              </select>
            </label>
          </form>
          <div className="finance-body">
            {write && chosen.length > 0 && !together && (
              <Alert kind="warning">{t.payment.mixed}</Alert>
            )}
            {write && chosen.length === 0 && items && items.some(payable) && (
              <p className="panel-note">{v.selectToPay}</p>
            )}
            {master.error && (
              <ResourceError error={master.error} retry={master.retry} />
            )}
            {items === null && list.error ? (
              <ResourceError error={list.error} retry={list.refresh} />
            ) : items === null ? (
              <Skeleton />
            ) : items.length === 0 ? (
              <Empty
                title={
                  filters.direction || filters.status
                    ? v.emptyFiltered
                    : v.empty
                }
                description={
                  filters.direction || filters.status ? undefined : v.emptyBody
                }
              />
            ) : (
              <div
                className="table-wrap"
                role="region"
                aria-label={v.list}
                tabIndex={0}
              >
                <table className="finance-table">
                  <thead>
                    <tr>
                      {write && (
                        <th scope="col">
                          <span className="sr-only">{v.columns.select}</span>
                        </th>
                      )}
                      <th scope="col">{v.columns.number}</th>
                      <th scope="col">{v.columns.counterparty}</th>
                      <th scope="col">{v.columns.kind}</th>
                      <th scope="col">{v.columns.due}</th>
                      <th scope="col" className="finance-num">
                        {v.columns.total}
                      </th>
                      <th scope="col" className="finance-num">
                        {v.columns.open}
                      </th>
                      <th scope="col">{v.columns.status}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((inv) => {
                      const credits = creditsText(t, inv, items);
                      return (
                        <tr
                          key={inv.id}
                          data-selected={inv.id === selected || undefined}
                        >
                          {write && (
                            <td>
                              {payable(inv) && (
                                <input
                                  type="checkbox"
                                  aria-label={`${v.columns.select}: ${inv.number ?? inv.issueDate}`}
                                  checked={picked.includes(inv.id)}
                                  onChange={() => toggle(inv.id)}
                                />
                              )}
                            </td>
                          )}
                          <th scope="row">
                            <button
                              type="button"
                              className="text-link"
                              aria-current={
                                inv.id === selected ? "true" : undefined
                              }
                              onClick={() => navigate({ invoice: inv.id })}
                            >
                              {inv.number ?? v.unnumbered}
                            </button>
                            {credits && (
                              <small className="field-hint">{credits}</small>
                            )}
                          </th>
                          <td>{nameOf(inv.counterpartyId)}</td>
                          <td>{v.kinds[inv.kind] ?? inv.kind}</td>
                          <td>
                            {inv.dueDate ? inv.dueDate.slice(0, 10) : "—"}
                          </td>
                          <td className="finance-num">
                            {formatMoney(inv.totalMicros, inv.currency, locale)}
                          </td>
                          <td className="finance-num">
                            {inv.openAmountMicros === null
                              ? "—"
                              : formatMoney(
                                  inv.openAmountMicros,
                                  inv.currency,
                                  locale,
                                )}
                          </td>
                          <td>
                            <Badge tone={statusTone(inv.displayStatus)}>
                              {v.statuses[inv.displayStatus] ??
                                inv.displayStatus}
                            </Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
        {selected && (
          <InvoiceDetailPanel
            key={selected}
            t={t}
            locale={locale}
            invoiceId={selected}
            counterparty={nameOf(
              items?.find((i) => i.id === selected)?.counterpartyId ?? null,
            )}
            canWrite={write}
            onClose={() => navigate({ invoice: null })}
            onChanged={(message) => {
              setNotice(message);
              refresh();
            }}
          />
        )}
      </div>
    </>
  );
}
