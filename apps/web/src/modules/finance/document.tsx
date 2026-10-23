"use client";
import { useReducer, useRef, useState } from "react";
import { Download, ExternalLink, RotateCcw, X } from "lucide-react";
import { ApiError, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Skeleton,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { AppLink } from "@/platform/ui/app-link";
import { ResourceError } from "@/platform/ui/collection";
import {
  financeApi,
  financePath,
  query,
  type Account,
  type Category,
  type CostCenter,
  type Counterparty,
  type DocumentDetail,
  type FinanceDocument,
  type Invoice,
  type SettingsResponse,
} from "./api";
import { useFinanceAccess } from "./access";
import { BookingForm, draftOf, type Booking } from "./booking-form";
import { DetailBack, useDetailFocus } from "./detail-head";
import { financeText, type FinanceText } from "./labels";

// The review detail (spec §9): the original beside the booking form, the
// duplicate decision, and the actions Save draft, Book, Reject and Retry.
// The original is shown from the file route, which answers inline only for
// PDF and images and always with a sandboxing CSP; this view never loosens
// that. Every action carries the document version; a 409 VERSION_CONFLICT
// asks the person to reload instead of overwriting.

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REJECTABLE = new Set(["received", "needs_review", "failed", "duplicate"]);

/** True while a duplicate question blocks booking. */
export const duplicateOpen = (doc: Pick<FinanceDocument, "status" | "flags">) =>
  doc.status === "duplicate" || doc.flags.includes("possible_duplicate");

/** The document this one may duplicate, when known. */
export function duplicateTarget(doc: FinanceDocument): string | null {
  const candidate = draftOf(doc).possibleDuplicateOfId;
  return (
    doc.duplicateOfId ?? (typeof candidate === "string" ? candidate : null)
  );
}

/** Retry is offered for a failed extraction and one still in `received` (the server refuses a running one). */
export const canRetry = (doc: Pick<FinanceDocument, "status">) =>
  doc.status === "failed" || doc.status === "received";

/**
 * The original: an image or a sandboxed PDF frame from the inline URL,
 * with Open and Download links always beneath a PDF (Chromium may not
 * render a PDF inside a sandboxed frame). Other types (XML, EML) are a
 * download link only and never load inline.
 */
export function DocumentPreview({
  t,
  doc,
  inlineUrl,
  downloadUrl,
}: {
  t: FinanceText;
  doc: Pick<FinanceDocument, "mimeType" | "originalName">;
  inlineUrl: string;
  downloadUrl: string;
}) {
  const r = t.review;
  const name = doc.originalName ?? t.dashboard.unnamedReceipt;
  const download = (
    <a className="text-link" href={downloadUrl} download>
      <Download aria-hidden size={14} />
      {r.download}
    </a>
  );
  if (IMAGE_TYPES.has(doc.mimeType))
    return (
      <figure className="finance-preview">
        <img src={inlineUrl} alt={`${r.previewTitle}: ${name}`} />
        <figcaption className="finance-preview-links">{download}</figcaption>
      </figure>
    );
  if (doc.mimeType === "application/pdf")
    return (
      <figure className="finance-preview">
        <iframe
          src={inlineUrl}
          title={`${r.previewTitle}: ${name}`}
          sandbox=""
          referrerPolicy="no-referrer"
        />
        <figcaption className="finance-preview-links">
          <span className="panel-note">{r.pdfHint}</span>
          <a
            className="text-link"
            href={inlineUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink aria-hidden size={14} />
            {r.open}
          </a>
          {download}
        </figcaption>
      </figure>
    );
  return (
    <div className="finance-preview">
      <p className="panel-note">{r.noPreview}</p>
      <p className="finance-preview-links">{download}</p>
    </div>
  );
}

/** The duplicate decision: a link to the original and the two choices. */
export function DuplicatePanel({
  t,
  doc,
  originalHref,
  canWrite,
  pending,
  onNotDuplicate,
  onReject,
}: {
  t: FinanceText;
  doc: FinanceDocument;
  originalHref: string | null;
  canWrite: boolean;
  pending: boolean;
  onNotDuplicate: () => void;
  onReject: () => void;
}) {
  const r = t.review;
  return (
    <section className="finance-duplicate" aria-label={r.duplicateTitle}>
      <Alert kind="warning">
        <strong>{r.duplicateTitle}.</strong>{" "}
        {doc.status === "duplicate" ? r.duplicateExact : r.duplicateBody}
      </Alert>
      <div className="settings-row-actions">
        {originalHref && (
          <AppLink className="text-link" href={originalHref}>
            {r.duplicateOriginal}
          </AppLink>
        )}
        {canWrite && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onNotDuplicate}
            >
              {r.notDuplicate}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={onReject}
            >
              {r.rejectDuplicate}
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

/** Flag badges with their text; severe flags in the danger tone. */
export function FlagBadges({
  t,
  flags,
}: {
  t: FinanceText;
  flags: readonly string[];
}) {
  if (!flags.length) return null;
  return (
    <span className="finance-flags">
      {flags.map((flag) => (
        <Badge key={flag} tone={SEVERE_FLAGS.has(flag) ? "danger" : "warning"}>
          {t.review.flags[flag] ?? t.review.flagUnknown}
        </Badge>
      ))}
    </span>
  );
}

/** Flags that sort a document up the queue (after failed ones). */
export const SEVERE_FLAGS: ReadonlySet<string> = new Set([
  "extraction_failed",
  "total_mismatch",
  "possible_duplicate",
  "unknown_currency",
]);

type Items<T> = { items: T[] };
type Notice = "saved" | "booked" | "rejected" | "retried" | "resolved" | null;

/**
 * The last non-null value: a refetch (which clears the resource's data)
 * keeps showing what was loaded before instead of unmounting the form.
 */
function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}

/** A saved document (an action's answer) over the loaded detail, keeping its history. */
export function mergeSaved(
  prev: DocumentDetail,
  saved: FinanceDocument,
): DocumentDetail {
  return {
    ...prev,
    ...saved,
    revisions: prev.revisions,
    invoices: prev.invoices,
  };
}

/**
 * The document the detail shows and the seed of its form. The form keeps
 * what the person typed across refetches and the person's own saves; it
 * is seeded again from the server (a new `seed`) only after a 409 Reload
 * (the next loaded detail) or a Retry (its answer).
 */
export type Shown = {
  doc: DocumentDetail | null;
  seed: number;
  /** Set by Reload: the next loaded detail reseeds the form. */
  reseed: boolean;
};
export type ShownAction =
  | { type: "loaded"; doc: DocumentDetail }
  | { type: "saved"; doc: FinanceDocument }
  | { type: "reload" }
  | { type: "replaced"; doc: FinanceDocument };

export const SHOWN_START: Shown = { doc: null, seed: 0, reseed: false };

export function shownReducer(state: Shown, action: ShownAction): Shown {
  switch (action.type) {
    case "loaded":
      return {
        doc: action.doc,
        seed: state.reseed ? state.seed + 1 : state.seed,
        reseed: false,
      };
    case "saved":
      return state.doc
        ? { ...state, doc: mergeSaved(state.doc, action.doc) }
        : state;
    case "reload":
      return { ...state, reseed: true };
    case "replaced":
      return state.doc
        ? {
            ...state,
            doc: mergeSaved(state.doc, action.doc),
            seed: state.seed + 1,
          }
        : state;
  }
}

/** The booking form's key: a new key mounts a form seeded from the document. */
export const formKey = (doc: Pick<FinanceDocument, "id">, seed: number) =>
  `${doc.id}:${seed}`;

/** The listed counterparties plus those created here, each once. */
export function withCreated(
  listed: readonly Counterparty[],
  created: readonly Counterparty[],
): Counterparty[] {
  const ids = new Set(listed.map((c) => c.id));
  return [...listed, ...created.filter((c) => !ids.has(c.id))];
}

/** The master data the form chooses from, kept across refetches. */
function useLists(projectId: string) {
  const path = (rest: string) => financePath(projectId, rest);
  const counterparties = useResource<Items<Counterparty>>(
    path("/counterparties"),
  );
  const categories = useResource<Items<Category>>(
    path(`/categories${query({ includeArchived: true })}`),
  );
  const costCenters = useResource<Items<CostCenter>>(
    path(`/cost-centers${query({ includeArchived: true })}`),
  );
  const accounts = useResource<Items<Account>>(
    path(`/accounts${query({ includeArchived: true })}`),
  );
  const invoices = useResource<Items<Invoice>>(
    path(`/invoices${query({ limit: 500 })}`),
  );
  const settings = useResource<SettingsResponse>(path("/settings"));
  const last = {
    counterparties: useLast(counterparties.data),
    categories: useLast(categories.data),
    costCenters: useLast(costCenters.data),
    accounts: useLast(accounts.data),
    invoices: useLast(invoices.data),
  };
  const lastSettings = useLast(settings.data);
  const all = [counterparties, categories, costCenters, accounts, invoices];
  return {
    lists: {
      counterparties: last.counterparties?.items ?? [],
      categories: last.categories?.items ?? [],
      costCenters: last.costCenters?.items ?? [],
      accounts: last.accounts?.items ?? [],
      invoices: last.invoices?.items ?? [],
    },
    settings: lastSettings?.settings ?? null,
    /** True until every list arrived once. */
    loading: Object.values(last).some((v) => v === null),
    error: all.find((r) => r.error)?.error ?? null,
    retry: () => all.forEach((r) => r.refresh()),
  };
}

/**
 * One document of the review queue. `hrefOf` builds the deep link of
 * another document (the duplicate's original); `onChanged` refreshes the
 * queue after an action.
 */
export function FinanceDocumentDetail({
  documentId,
  hrefOf,
  onClose,
  onChanged,
}: {
  documentId: string;
  hrefOf: (id: string) => string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { project, locale } = useWorkspace();
  const t = financeText(locale);
  const r = t.review;
  const { write } = useFinanceAccess();
  const finance = financeApi(project.id);
  const detail = useResource<DocumentDetail>(
    financePath(project.id, `/documents/${encodeURIComponent(documentId)}`),
  );
  const lists = useLists(project.id);
  const [created, setCreated] = useState<Counterparty[]>([]);
  // The document shown: the loaded detail, then each action's answer. It
  // is kept while a refetch runs, so the form stays mounted (shownReducer).
  const [shown, dispatch] = useReducer(shownReducer, SHOWN_START);
  const [seen, setSeen] = useState<DocumentDetail | null>(null);
  if (detail.data !== seen) {
    setSeen(detail.data);
    if (detail.data) dispatch({ type: "loaded", doc: detail.data });
  }
  const doc = shown.doc;
  const heading = useDetailFocus(Boolean(doc));
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookError, setBookError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [reason, setReason] = useState("");

  /**
   * Runs one action at a time (a ref lock, so a double click posts once);
   * maps its error code. An answer that is the document replaces the shown
   * one; a booking refetches the detail.
   */
  async function act<T>(
    task: () => Promise<T>,
    done: Notice,
    options: {
      book?: boolean;
      saved?: (result: T) => FinanceDocument;
      /** The answer reseeds the form (Retry: a new extraction follows). */
      reseed?: boolean;
    } = {},
  ): Promise<T | undefined> {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await task();
      setBookError(null);
      setNotice(done);
      if (options.saved) {
        dispatch({
          type: options.reseed ? "replaced" : "saved",
          doc: options.saved(result),
        });
      } else if (done) detail.refresh();
      if (done) onChanged();
      return result;
    } catch (e) {
      const code = e instanceof ApiError ? e.code : null;
      if (code === "VERSION_CONFLICT") setConflict(true);
      else if (options.book && code === "FX_RATE_MISSING") setBookError(code);
      else setError(e instanceof Error ? e.message : "Request failed.");
      return undefined;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }

  if (!doc)
    return detail.error ? (
      <ResourceError error={detail.error} retry={detail.refresh} />
    ) : (
      <Skeleton />
    );
  const asDoc = (result: FinanceDocument) => result;

  const status = r.statuses[doc.status] ?? doc.status;
  const target = duplicateTarget(doc);
  const reject = (text: string) =>
    act(
      () =>
        finance.documents.reject(doc.id, {
          version: doc.version,
          reason: text,
        }),
      "rejected",
      { saved: asDoc },
    );
  return (
    <article
      className="panel finance-detail"
      aria-label={doc.originalName ?? t.dashboard.unnamedReceipt}
    >
      <DetailBack label={t.manage.back} onBack={onClose} />
      <div className="panel-head">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {doc.originalName ?? t.dashboard.unnamedReceipt}
          </h2>
          <p className="finance-detail-meta">
            <Badge tone={doc.status === "failed" ? "danger" : "neutral"}>
              {status}
            </Badge>
            <FlagBadges t={t} flags={doc.flags} />
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={r.close}
          onClick={onClose}
        >
          <X aria-hidden size={16} />
        </Button>
      </div>
      <div className="finance-body">
        {detail.error && (
          <ResourceError error={detail.error} retry={detail.refresh} />
        )}
        {conflict && (
          <Alert kind="warning">
            {r.conflict}{" "}
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setConflict(false);
                setBookError(null);
                dispatch({ type: "reload" });
                detail.refresh();
                onChanged();
              }}
            >
              {r.reload}
            </Button>
          </Alert>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        {notice && <Alert kind="success">{r[notice]}</Alert>}
        {!write && <p className="panel-note">{r.readOnly}</p>}
        {doc.status === "failed" && (
          <p className="panel-note">{r.failedHint}</p>
        )}
        {doc.status === "received" && (
          <p className="panel-note">{r.receivedHint}</p>
        )}
        {(doc.status === "booked" || doc.status === "rejected") && (
          <p className="panel-note">
            {r.notEditable.replace("{status}", () => status.toLowerCase())}
          </p>
        )}
        {doc.rejectionReason && (
          <p className="panel-note">
            {r.rejectionReason.replace(
              "{reason}",
              () => doc.rejectionReason ?? "",
            )}
          </p>
        )}
        {duplicateOpen(doc) && REJECTABLE.has(doc.status) && (
          <DuplicatePanel
            t={t}
            doc={doc}
            originalHref={target && target !== doc.id ? hrefOf(target) : null}
            canWrite={write}
            pending={pending}
            onNotDuplicate={() =>
              act(
                () => finance.documents.notDuplicate(doc.id, doc.version),
                "resolved",
                { saved: asDoc },
              )
            }
            onReject={() => reject(r.duplicateReason)}
          />
        )}
        <div className="finance-detail-split">
          <section aria-label={r.original}>
            <h3>{r.original}</h3>
            <DocumentPreview
              t={t}
              doc={doc}
              inlineUrl={finance.documents.fileUrl(doc.id, "inline")}
              downloadUrl={finance.documents.fileUrl(doc.id, "attachment")}
            />
          </section>
          <section aria-label={r.form}>
            <h3>{r.form}</h3>
            {lists.error && (
              <ResourceError error={lists.error} retry={lists.retry} />
            )}
            {lists.loading ? (
              lists.error ? null : (
                <Skeleton />
              )
            ) : (
              <BookingForm
                key={formKey(doc, shown.seed)}
                t={t}
                locale={locale}
                doc={doc}
                lists={{
                  ...lists.lists,
                  counterparties: withCreated(
                    lists.lists.counterparties,
                    created,
                  ),
                }}
                currencies={lists.settings?.currencies}
                baseCurrency={lists.settings?.baseCurrency}
                canWrite={write}
                pending={pending}
                bookError={bookError}
                duplicateOpen={duplicateOpen(doc)}
                onBook={(booking: Booking) =>
                  act(
                    () => finance.documents.book(doc.id, doc.version, booking),
                    "booked",
                    { book: true },
                  )
                }
                onSave={(patch) =>
                  act(
                    () => finance.documents.patch(doc.id, doc.version, patch),
                    "saved",
                    { saved: asDoc },
                  )
                }
                onCreateCounterparty={async (name) => {
                  // Appended locally and selected by the form; no refetch.
                  const made = await act(
                    () => finance.counterparties.create({ name }),
                    null,
                  );
                  if (made) setCreated((list) => [...list, made]);
                  return made?.id;
                }}
              />
            )}
          </section>
        </div>
        {write && (canRetry(doc) || REJECTABLE.has(doc.status)) && (
          <div className="finance-detail-actions">
            {canRetry(doc) && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  act(() => finance.documents.retry(doc.id), "retried", {
                    saved: asDoc,
                    reseed: true,
                  })
                }
              >
                <RotateCcw aria-hidden size={14} />
                {r.retry}
              </Button>
            )}
            {REJECTABLE.has(doc.status) && (
              <form
                className="finance-inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim()) reject(reason.trim());
                }}
              >
                <label>
                  <span>{r.rejectReason}</span>
                  <Textarea
                    id={`finance-reject-${doc.id}`}
                    rows={2}
                    maxLength={1000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="destructive"
                  disabled={pending || !reason.trim()}
                >
                  {r.reject}
                </Button>
              </form>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
