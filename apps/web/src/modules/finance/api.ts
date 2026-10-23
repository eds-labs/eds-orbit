import { api, post } from "@/lib/api";

// The finance module's client side: hand-written types of the finance API
// (apps/api/src/modules/finance/routes.ts) and one typed helper per route.
// Amounts (`*Micros`) are bigint micros sent as decimal strings; dates are
// "YYYY-MM-DD" or ISO timestamps. Rates are decimal strings.

export type FinanceSettings = {
  baseCurrency: string;
  currencies: string[];
  usdcPeg: string;
  fxSource: "ecb" | "manual";
  aiExtraction: "off" | "on";
  aiDailyCeilingMicros: number;
  archiveAfter: "extracted" | "booked";
  retentionYears: number;
  duplicateWindowDays: number;
  reviewConfidence: number;
};
export type SettingsResponse = { settings: FinanceSettings; version: number };
export type SetupStatus = { ready: boolean; missingRoles: string[] };

export type Account = {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "income" | "expense";
  role: string | null;
  paymentAccount: boolean;
  currency: string | null;
  externalCode: string | null;
  version: number;
  archivedAt: string | null;
};
export type Category = {
  id: string;
  name: string;
  kind: "income" | "expense";
  parentId: string | null;
  accountId: string;
  version: number;
  archivedAt: string | null;
};
export type CostCenter = {
  id: string;
  code: string;
  name: string;
  orbitProjectId: string | null;
  version: number;
  archivedAt: string | null;
};
export type Counterparty = {
  id: string;
  name: string;
  taxId: string | null;
  emailDomains: string[];
  defaultCategoryId: string | null;
  defaultAllocation: unknown;
  version: number;
};
export type Recurring = {
  id: string;
  name: string;
  counterpartyId: string | null;
  categoryId: string | null;
  allocation: unknown;
  interval: string;
  expectedAmountMicros: string;
  currency: string;
  nextDueDate: string;
  active: boolean;
  match: unknown;
  version: number;
};

export type FinanceDocument = {
  id: string;
  fileId: string;
  source: string;
  originalName: string | null;
  mimeType: string;
  status:
    | "received"
    | "needs_review"
    | "failed"
    | "duplicate"
    | "booked"
    | "rejected";
  docType: string;
  extraction: unknown;
  confidence: number | null;
  flags: string[];
  duplicateOfId: string | null;
  rejectionReason: string | null;
  version: number;
  createdAt: string;
};
export type DocumentDetail = FinanceDocument & {
  revisions: Array<{
    id: string;
    version: number;
    actorUserId: string | null;
    changes: unknown;
    createdAt: string;
  }>;
  invoices: Array<{ id: string; status: string; kind: string }>;
};
export type JournalLine = {
  id: string;
  entryId: string;
  accountId: string;
  side: "debit" | "credit";
  currency: string;
  amountMicros: string;
  fxRate: string;
  rateDate: string;
  rateSource: string;
  baseAmountMicros: string;
  categoryId: string | null;
  costCenterId: string | null;
};
export type JournalEntry = {
  id: string;
  number: string;
  entryDate: string;
  kind: string;
  status: string;
  memo: string | null;
  documentId: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversalOfId: string | null;
  reversedById: string | null;
  lines: JournalLine[];
  /** Entry detail of a payment: the invoices it was allocated to. */
  paymentInvoices?: Array<{ id: string; number: string | null }>;
};
export type Invoice = {
  id: string;
  kind: string;
  direction: "payable" | "receivable";
  counterpartyId: string | null;
  creditsInvoiceId: string | null;
  number: string | null;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  netMicros: string;
  taxMicros: string;
  totalMicros: string;
  status: string;
  displayStatus: string;
  openAmountMicros: string | null;
  documentId: string | null;
  version: number;
};
export type InvoiceDetail = Invoice & {
  lines: Array<{
    id: string;
    position: number;
    description: string;
    quantity: string;
    amountMicros: string;
    taxMicros: string;
    categoryId: string | null;
  }>;
  allocations: Array<{
    id: string;
    paymentId: string;
    amountMicros: string;
    baseMicros: string;
    /** When the payment was voided; null while it is live. */
    voidedAt: string | null;
  }>;
};

/** An e-mail connection bound to finance, with its latest archive error code. */
export type MailboxBinding = {
  id: string;
  emailConnectionId: string;
  archiveFolder: string;
  active: boolean;
  version: number;
  lastArchiveError: string | null;
};
export type FxRate = {
  id: string;
  date: string;
  currency: string;
  perEur: string;
  source: string;
};
export type FinanceExport = {
  id: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  createdAt: string;
};

export type Money = string;
export type OpenBucket = {
  count: number;
  totalMicros: Money;
  payableMicros: Money;
  receivableMicros: Money;
};
export type Summary = {
  baseCurrency: string;
  from: string;
  to: string;
  months: Array<{
    month: string;
    incomeMicros: Money;
    expenseMicros: Money;
    resultMicros: Money;
  }>;
  open: OpenBucket;
  overdue: OpenBucket;
  recurringMonthlyMicros: Money;
  /** How many recurring items have no exchange rate to the base currency. */
  recurringMissingRate: number;
  /** `name: null` is "Unassigned" (labels.financeReportUnassigned). */
  byCostCenter: Array<{
    id: string | null;
    name: string | null;
    expenseMicros: Money;
  }>;
  /** `name: null` is "Other" (financeReportOther) or, with `id: null`, uncategorized. */
  byCategory: Array<{
    id: string | null;
    name: string | null;
    other?: true;
    months: Array<{ month: string; expenseMicros: Money }>;
  }>;
  reviewCount: number;
};
export type CostReport = {
  baseCurrency: string;
  kind: "income" | "expense";
  groupBy: "month" | "category" | "costCenter";
  from: string;
  to: string;
  totalMicros: Money;
  rows: Array<
    Record<string, unknown> & { name?: string | null; id?: string | null }
  >;
  matched: string[];
  matchedCostCenters: string[];
};
/** An invoice still open at the end of the year (reports/year). */
export type YearOpenItem = {
  invoiceId: string;
  number: string | null;
  direction: "payable" | "receivable";
  counterpartyId: string | null;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  openMicros: Money;
  openBaseMicros: Money;
};
export type YearOverview = {
  baseCurrency: string;
  year: number;
  months: string[];
  categories: Array<{
    id: string | null;
    name: string | null;
    kind: "income" | "expense";
    months: Array<{ month: string; amountMicros: Money }>;
    totalMicros: Money;
  }>;
  costCenters: Array<{
    id: string | null;
    name: string | null;
    expenseMicros: Money;
  }>;
  open: YearOpenItem[];
  documents: Array<{
    id: string;
    invoiceId: string;
    number: string | null;
    issueDate: string;
    counterparty: string | null;
    currency: string;
    totalMicros: Money;
    totalBaseMicros: Money | null;
    entryNumber: string | null;
  }>;
};

export const financePath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/finance${rest}`;

const send = <T>(method: string, path: string, data?: unknown) =>
  api<T>(path, {
    method,
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
const put = <T>(path: string, data: unknown) => send<T>("PUT", path, data);
const patch = <T>(path: string, data: unknown) => send<T>("PATCH", path, data);
const del = <T>(path: string) => send<T>("DELETE", path);
const get = <T>(path: string) => api<T>(path);

/** `?a=1&b=2` from the defined values, or "". */
export function query(
  values: Record<string, string | number | boolean | undefined | null>,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}

type Items<T> = { items: T[] };
type Version = { version: number };

/** Master data with the same five routes: list, create, update, archive, delete. */
function masterData<T, C, U>(name: string) {
  return (projectId: string) => {
    const base = financePath(projectId, `/${name}`);
    return {
      list: (
        options: { includeArchived?: boolean; includeInactive?: boolean } = {},
      ) =>
        get<Items<T>>(
          `${base}${query({
            includeArchived: options.includeArchived || undefined,
            includeInactive: options.includeInactive || undefined,
          })}`,
        ),
      create: (body: C) => post<T>(base, body),
      update: (id: string, body: U & Version) =>
        patch<T>(`${base}/${id}`, body),
      archive: (id: string) => post<T>(`${base}/${id}/archive`, {}),
      remove: (id: string) =>
        del<{ id: string; deleted: true }>(`${base}/${id}`),
    };
  };
}

export const accountsApi = masterData<
  Account,
  {
    code: string;
    name: string;
    type: Account["type"];
    role?: string | null;
    paymentAccount?: boolean;
    currency?: string | null;
    externalCode?: string | null;
  },
  Partial<
    Pick<Account, "name" | "paymentAccount" | "currency" | "externalCode">
  >
>("accounts");
export const categoriesApi = masterData<
  Category,
  {
    name: string;
    kind: Category["kind"];
    accountId: string;
    parentId?: string | null;
  },
  Partial<Pick<Category, "name" | "parentId" | "accountId">>
>("categories");
export const costCentersApi = masterData<
  CostCenter,
  { code: string; name: string; orbitProjectId?: string | null },
  Partial<Pick<CostCenter, "name" | "orbitProjectId">>
>("cost-centers");
export const counterpartiesApi = masterData<
  Counterparty,
  Partial<Omit<Counterparty, "id" | "version">> & { name: string },
  Partial<Omit<Counterparty, "id" | "version">>
>("counterparties");
export const recurringApi = masterData<
  Recurring,
  Partial<Omit<Recurring, "id" | "version">> & {
    name: string;
    interval: string;
    expectedAmountMicros: string;
    currency: string;
    nextDueDate: string;
  },
  Partial<Omit<Recurring, "id" | "version">>
>("recurring");

/** Every finance route of one project, typed. */
export function financeApi(projectId: string) {
  const base = (rest = "") => financePath(projectId, rest);
  return {
    settings: {
      get: () => get<SettingsResponse>(base("/settings")),
      put: (settings: Partial<FinanceSettings>, version: number) =>
        put<SettingsResponse>(base("/settings"), { settings, version }),
    },
    setup: {
      get: () => get<SetupStatus>(base("/setup")),
      apply: () => post<{ created: number }>(base("/setup"), {}),
    },
    summary: (range: { from: string; to: string }) =>
      get<Summary>(base(`/summary${query(range)}`)),
    reports: {
      costs: (params: {
        from: string;
        to: string;
        groupBy?: "month" | "category" | "costCenter";
        category?: string;
        costCenter?: string;
        kind?: "income" | "expense";
      }) => get<CostReport>(base(`/reports/costs${query(params)}`)),
      year: (year: number) =>
        get<YearOverview>(base(`/reports/year${query({ year })}`)),
    },
    documents: {
      list: (
        params: { status?: FinanceDocument["status"]; limit?: number } = {},
      ) => get<Items<FinanceDocument>>(base(`/documents${query(params)}`)),
      get: (id: string) => get<DocumentDetail>(base(`/documents/${id}`)),
      /** Raw bytes like the platform file route; the name travels encoded. */
      upload: (file: File) =>
        api<unknown>(base("/documents"), {
          method: "POST",
          body: file,
          headers: {
            "Content-Type": "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name),
            "x-file-type": file.type || "application/octet-stream",
          },
        }),
      // The review actions answer the document without its history.
      patch: (id: string, version: number, changes: Record<string, unknown>) =>
        patch<FinanceDocument>(base(`/documents/${id}`), {
          ...changes,
          version,
        }),
      book: (id: string, version: number, booking: unknown) =>
        post<unknown>(base(`/documents/${id}/book`), { version, booking }),
      reject: (id: string, body: { version: number; reason?: string }) =>
        post<FinanceDocument>(base(`/documents/${id}/reject`), body),
      notDuplicate: (id: string, version: number) =>
        post<FinanceDocument>(base(`/documents/${id}/not-duplicate`), {
          version,
        }),
      retry: (id: string) =>
        post<FinanceDocument>(base(`/documents/${id}/retry`), {}),
      fileUrl: (
        id: string,
        disposition: "inline" | "attachment" = "attachment",
      ) => `/api${base(`/documents/${id}/file${query({ disposition })}`)}`,
    },
    entries: {
      list: (
        params: {
          from?: string;
          to?: string;
          account?: string;
          category?: string;
          costCenter?: string;
          kind?: string;
          q?: string;
          limit?: number;
        } = {},
      ) => get<Items<JournalEntry>>(base(`/entries${query(params)}`)),
      get: (id: string) => get<JournalEntry>(base(`/entries/${id}`)),
      post: (body: unknown) => post<JournalEntry>(base("/entries"), body),
      reverse: (id: string, body: { reason: string; date?: string }) =>
        post<JournalEntry>(base(`/entries/${id}/reverse`), body),
    },
    invoices: {
      list: (
        params: {
          direction?: "payable" | "receivable";
          status?: string;
          overdue?: boolean;
          limit?: number;
        } = {},
      ) => get<Items<Invoice>>(base(`/invoices${query(params)}`)),
      get: (id: string) => get<InvoiceDetail>(base(`/invoices/${id}`)),
      void: (id: string, body: unknown = {}) =>
        post<unknown>(base(`/invoices/${id}/void`), body),
    },
    payments: {
      post: (body: unknown) => post<unknown>(base("/payments"), body),
      void: (id: string, body: unknown = {}) =>
        post<unknown>(base(`/payments/${id}/void`), body),
    },
    accounts: accountsApi(projectId),
    categories: categoriesApi(projectId),
    costCenters: costCentersApi(projectId),
    counterparties: counterpartiesApi(projectId),
    recurring: recurringApi(projectId),
    mailboxes: {
      list: () => get<Items<MailboxBinding>>(base("/mailboxes")),
      bind: (body: { emailConnectionId: string; archiveFolder?: string }) =>
        post<MailboxBinding>(base("/mailboxes"), body),
      unbind: (id: string) =>
        del<{ id: string; unbound: true }>(base(`/mailboxes/${id}`)),
    },
    fxRates: {
      list: (date?: string) =>
        get<Items<FxRate>>(base(`/fx-rates${query({ date })}`)),
      set: (body: { date: string; currency: string; perEur: string }) =>
        post<FxRate>(base("/fx-rates"), body),
    },
    exports: {
      list: () => get<Items<FinanceExport>>(base("/exports")),
      create: (body: { kind: string; from: string; to: string }) =>
        post<FinanceExport>(base("/exports"), body),
      fileUrl: (id: string) => `/api${base(`/exports/${id}/file`)}`,
    },
  };
}
