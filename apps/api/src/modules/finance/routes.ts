import { z } from "zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import type { RoutesContribution } from "../../platform/http/routes.ts";
import type { Auth } from "../../platform/tenancy/auth.ts";
import { scopeFor } from "../../platform/tenancy/auth.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import { assertModuleEnabledFor } from "../../platform/modules/enforcement.ts";
import { readFile } from "../../platform/files/files.ts";
import { contentDisposition } from "../../platform/files/routes.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  archiveAccount,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from "./accounts.ts";
import {
  archiveCategory,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from "./categories.ts";
import {
  archiveCostCenter,
  createCostCenter,
  deleteCostCenter,
  listCostCenters,
  updateCostCenter,
} from "./cost-centers.ts";
import {
  createCounterparty,
  deleteCounterparty,
  listCounterparties,
  updateCounterparty,
} from "./counterparties.ts";
import { createExport } from "./exports/exporter.ts";
import { setManualRate } from "./fx.ts";
import { requireFinance } from "./gate.ts";
import { ingestDocument } from "./intake/documents.ts";
import { voidInvoice } from "./invoices.ts";
import { reverseEntry } from "./ledger/reversal.ts";
import { bindMailbox, unbindMailbox } from "./mailboxes.ts";
import { postManualEntry } from "./manual-entries.ts";
import { recordPayment, voidPayment } from "./payments.ts";
import {
  FINANCE_EXPORT,
  FINANCE_READ,
  FINANCE_SETTINGS,
  FINANCE_WRITE,
} from "./permissions.ts";
import {
  documentDetail,
  documentFile,
  entryDetail,
  exportFile,
  invoiceDetail,
  listDocuments,
  listEntries,
  listExports,
  listFxRates,
  listInvoices,
  mailboxesView,
  setupStatus,
} from "./queries.ts";
import {
  archiveRecurring,
  createRecurring,
  deleteRecurring,
  listRecurring,
  updateRecurring,
} from "./recurring.ts";
import { costReport, financeSummary, yearOverview } from "./reports.ts";
import {
  bookDocument,
  markNotDuplicate,
  rejectDocument,
  retryExtraction,
  updateDraft,
} from "./review.ts";
import { applyFinanceTemplate } from "./setup.ts";
import { readFinanceSettings, writeFinanceSettings } from "./settings.ts";
import { microsIn, toJson } from "./views.ts";

// The finance HTTP API (spec §8): a thin layer over the services. Every
// route checks the member's finance permission, then that finance is on in
// the project (404 FINANCE_DISABLED), then runs in one project transaction.
// Reads need finance.read, mutations finance.write, exports finance.export;
// setup, mailboxes, settings, account writes and manual rates are the
// owner's (finance.settings). Responses carry bigint micros as strings.

const BASE = "/api/projects/:projectId/finance";
const MODULE = "finance";
const recordId = z.uuid();
/** Types a browser may show inline; anything else is only downloaded. */
const INLINE_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const UPLOAD_RATE = { rateLimit: { max: 60, timeWindow: "1 minute" } };
const EXPORT_RATE = { rateLimit: { max: 10, timeWindow: "1 minute" } };

type Params = { projectId: string; id?: string };
type Req = Parameters<typeof scopeFor>[1];

const settingsInput = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    version: z.number().int().min(1),
  })
  .strict();
const versionInput = z.object({ version: z.number().int().min(1) }).strict();
const patchInput = z
  .object({ version: z.number().int().min(1) })
  .catchall(z.unknown());
const bookInput = z
  .object({ version: z.number().int().min(1), booking: z.unknown() })
  .strict();
const reverseInput = z
  .object({
    reason: z.string().trim().min(1).max(1000),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
const rateInput = z
  .object({
    date: z.string(),
    currency: z.string(),
    perEur: z.string().max(40),
  })
  .strict();
const exportInput = z
  .object({ kind: z.string().max(40), from: z.string(), to: z.string() })
  .strict();
const rangeQuery = z.object({ from: z.string(), to: z.string() }).strict();
const costQuery = z
  .object({
    from: z.string(),
    to: z.string(),
    groupBy: z.enum(["month", "category", "costCenter"]).default("month"),
    category: z.string().trim().min(1).max(160).optional(),
    costCenter: z.string().trim().min(1).max(160).optional(),
    kind: z.enum(["income", "expense"]).default("expense"),
  })
  .strict();
const yearQuery = z
  .object({ year: z.coerce.number().int().min(1970).max(9999) })
  .strict();
const archivedQuery = z
  .object({ includeArchived: z.enum(["true", "false"]).optional() })
  .strict();
const inactiveQuery = z
  .object({ includeInactive: z.enum(["true", "false"]).optional() })
  .strict();
const dispositionQuery = z
  .object({
    disposition: z.enum(["inline", "attachment"]).default("attachment"),
  })
  .strict();

/** The member's scope with `required` checked and finance on in the project. */
async function financeScope(auth: Auth, req: Req, required: PermissionDef) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId, required);
  await scoped(scope.workspaceId, scope.projectId, (tx) =>
    requireFinance(tx, scope),
  );
  return scope;
}

/**
 * Runs a finance handler: the member's permission in the module first, then
 * the finance gate and the work in one project transaction. The result is
 * returned as JSON (bigint as decimal strings).
 */
async function inFinance<T>(
  auth: Auth,
  req: Req,
  required: PermissionDef,
  work: (tx: DbTx, scope: Scope, params: Params) => Promise<T>,
) {
  const params = req.params as Params;
  const scope = await scopeFor(auth, req, params.projectId, required);
  const result = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      await requireFinance(tx, scope);
      return work(tx, scope, params);
    },
  );
  return toJson(result);
}

const idOf = (p: Params) => recordId.parse(p.id);
const items = async <T>(rows: Promise<T[]>) => ({ items: await rows });

/** Payment micros arrive as decimal strings; the service takes bigint. */
function paymentBody(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  return {
    ...body,
    ...("amountMicros" in body
      ? { amountMicros: microsIn(body.amountMicros) }
      : {}),
    ...(Array.isArray(body.allocations)
      ? {
          allocations: body.allocations.map((a) =>
            a && typeof a === "object"
              ? {
                  ...(a as Record<string, unknown>),
                  amountMicros: microsIn(
                    (a as Record<string, unknown>).amountMicros,
                  ),
                }
              : a,
          ),
        }
      : {}),
  };
}

/** Sends a stored finance file with headers that keep a browser from running it. */
async function sendFile(
  reply: FastifyReply,
  scope: Scope,
  fileId: string,
  disposition: "inline" | "attachment",
) {
  const { file, bytes } = await readFile(scope, fileId);
  if (file.moduleId !== MODULE) throw new DomainError("NOT_FOUND", 404);
  if (disposition === "inline" && !INLINE_TYPES.has(file.mime))
    throw new DomainError("FINANCE_INLINE_NOT_ALLOWED", 415);
  return reply
    .header("Content-Type", file.mime)
    .header("Content-Length", String(bytes.byteLength))
    .header(
      "Content-Disposition",
      contentDisposition(disposition, file.name ?? "file"),
    )
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; sandbox")
    .header("Cache-Control", "private, no-store")
    .send(Buffer.from(bytes));
}

type MasterData = {
  list: (tx: DbTx, scope: Scope, query: unknown) => Promise<unknown[]>;
  create: (tx: DbTx, scope: Scope, raw: unknown) => Promise<unknown>;
  update: (
    tx: DbTx,
    scope: Scope,
    id: string,
    raw: unknown,
  ) => Promise<unknown>;
  archive?: (tx: DbTx, scope: Scope, id: string) => Promise<unknown>;
  remove: (tx: DbTx, scope: Scope, id: string) => Promise<unknown>;
};

/** Finance HTTP routes (spec §8). */
export const financeRoutes: RoutesContribution = ({ app, auth }) => {
  /** List, create, update, archive and delete of one kind of master data. */
  const masterData = (
    path: string,
    write: PermissionDef,
    service: MasterData,
  ) => {
    app.get(`${BASE}/${path}`, (req) =>
      inFinance(auth, req, FINANCE_READ, async (tx, scope) => ({
        items: await service.list(tx, scope, req.query ?? {}),
      })),
    );
    app.post(`${BASE}/${path}`, (req) =>
      inFinance(auth, req, write, (tx, scope) =>
        service.create(tx, scope, req.body),
      ),
    );
    app.patch(`${BASE}/${path}/:id`, (req) =>
      inFinance(auth, req, write, (tx, scope, p) =>
        service.update(tx, scope, idOf(p), req.body),
      ),
    );
    const archive = service.archive;
    if (archive)
      app.post(`${BASE}/${path}/:id/archive`, (req) =>
        inFinance(auth, req, write, (tx, scope, p) =>
          archive(tx, scope, idOf(p)),
        ),
      );
    // Refused with 409 FINANCE_IN_USE while anything references the row.
    app.delete(`${BASE}/${path}/:id`, (req) =>
      inFinance(auth, req, write, async (tx, scope, p) => {
        const id = idOf(p);
        await service.remove(tx, scope, id);
        return { id, deleted: true };
      }),
    );
  };
  const includeArchived = (query: unknown) => ({
    includeArchived: archivedQuery.parse(query).includeArchived === "true",
  });

  // Settings and the starting chart of accounts.
  app.get(`${BASE}/settings`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      readFinanceSettings(tx, scope),
    ),
  );
  app.put(`${BASE}/settings`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, (tx, scope) => {
      const { settings, version } = settingsInput.parse(req.body);
      return writeFinanceSettings(tx, scope, version, settings);
    }),
  );
  app.get(`${BASE}/setup`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) => setupStatus(tx, scope)),
  );
  app.post(`${BASE}/setup`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, (tx, scope) =>
      applyFinanceTemplate(tx, scope),
    ),
  );

  // Overview and reports.
  app.get(`${BASE}/summary`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      financeSummary(tx, scope, rangeQuery.parse(req.query ?? {})),
    ),
  );
  app.get(`${BASE}/reports/costs`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      costReport(tx, scope, costQuery.parse(req.query ?? {})),
    ),
  );
  app.get(`${BASE}/reports/year`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      yearOverview(tx, scope, yearQuery.parse(req.query ?? {}).year),
    ),
  );

  // Documents. The upload takes the raw bytes like the platform file route;
  // storing the file opens its own transactions, so it runs after the gate.
  const uploadScope = new WeakMap<object, Scope>();
  app.register(async (child) => {
    child.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: loadConfig().FILES_MAX_BYTES },
      (_req, body, done) => done(null, body),
    );
    child.post(
      `${BASE}/documents`,
      {
        bodyLimit: loadConfig().FILES_MAX_BYTES,
        config: UPLOAD_RATE,
        // Membership, module, finance gate, permission and content type are
        // checked before a byte of the body is read, in the order every
        // other finance route checks them.
        onRequest: async (req) => {
          (req as { orbitModule?: string }).orbitModule = MODULE;
          const { projectId } = req.params as Params;
          const member = await scopeFor(auth, req, projectId);
          await assertModuleEnabledFor(member, MODULE);
          authorize(member, FINANCE_WRITE);
          await scoped(member.workspaceId, member.projectId, (tx) =>
            requireFinance(tx, member),
          );
          const type = (req.headers["content-type"] ?? "")
            .split(";")[0]!
            .trim()
            .toLowerCase();
          if (type !== "application/octet-stream")
            throw new DomainError("FILE_BODY_REQUIRED", 415);
          uploadScope.set(req, member);
        },
      },
      async (req: FastifyRequest, reply) => {
        const scope = uploadScope.get(req);
        if (!scope || !Buffer.isBuffer(req.body))
          throw new DomainError("FILE_BODY_REQUIRED", 415);
        const name = req.headers["x-file-name"];
        let decoded: string | undefined;
        if (typeof name === "string")
          try {
            decoded = decodeURIComponent(name);
          } catch {
            decoded = undefined;
          }
        const result = await ingestDocument(scope, {
          source: "upload",
          bytes: req.body,
          mime: String(req.headers["x-file-type"] ?? ""),
          ...(decoded ? { name: decoded } : {}),
        });
        return reply.code(201).send(toJson(result));
      },
    );
  });
  app.get(`${BASE}/documents`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      items(listDocuments(tx, scope, req.query)),
    ),
  );
  app.get(`${BASE}/documents/:id`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope, p) =>
      documentDetail(tx, scope, idOf(p)),
    ),
  );
  app.patch(`${BASE}/documents/:id`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) => {
      const { version, ...patch } = patchInput.parse(req.body);
      return updateDraft(tx, scope, idOf(p), version, patch);
    }),
  );
  app.post(`${BASE}/documents/:id/book`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) => {
      const input = bookInput.parse(req.body);
      return bookDocument(tx, scope, idOf(p), {
        version: input.version,
        booking: input.booking as Parameters<typeof bookDocument>[3]["booking"],
      });
    }),
  );
  app.post(`${BASE}/documents/:id/reject`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) =>
      rejectDocument(tx, scope, idOf(p), req.body as never),
    ),
  );
  app.post(`${BASE}/documents/:id/not-duplicate`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) =>
      markNotDuplicate(tx, scope, idOf(p), versionInput.parse(req.body)),
    ),
  );
  app.post(`${BASE}/documents/:id/retry`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) =>
      retryExtraction(tx, scope, idOf(p)),
    ),
  );
  // The original, inline only for types a browser shows without running
  // anything (PDF and images); everything else is an attachment.
  app.get(`${BASE}/documents/:id/file`, async (req, reply) => {
    const scope = await financeScope(auth, req, FINANCE_READ);
    const id = idOf(req.params as Params);
    const { disposition } = dispositionQuery.parse(req.query ?? {});
    const target = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      documentFile(tx, scope, id),
    );
    if (disposition === "inline" && !INLINE_TYPES.has(target.mime))
      throw new DomainError("FINANCE_INLINE_NOT_ALLOWED", 415);
    return sendFile(reply, scope, target.fileId, disposition);
  });

  // Journal. Only manual entries are reversed here; invoice and payment
  // postings are corrected by voiding the invoice or payment, which keeps
  // their status and allocations consistent.
  app.get(`${BASE}/entries`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      items(listEntries(tx, scope, req.query)),
    ),
  );
  app.get(`${BASE}/entries/:id`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope, p) =>
      entryDetail(tx, scope, idOf(p)),
    ),
  );
  app.post(`${BASE}/entries`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope) =>
      postManualEntry(tx, scope, req.body as never),
    ),
  );
  app.post(`${BASE}/entries/:id/reverse`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, async (tx, scope, p) => {
      const id = idOf(p);
      const input = reverseInput.parse(req.body);
      const entry = await tx.financeJournalEntry.findFirst({
        where: { projectId: scope.projectId, id },
        select: { kind: true, sourceType: true },
      });
      if (!entry) throw new DomainError("FINANCE_ENTRY_NOT_FOUND", 404);
      // A reversal answers FINANCE_REVERSAL_NOT_REVERSIBLE from the service.
      if (entry.kind !== "reversal" && entry.sourceType !== "manual")
        throw new DomainError("FINANCE_USE_VOID", 409);
      return reverseEntry(tx, scope, id, input.reason, input.date);
    }),
  );

  // Invoices and payments.
  app.get(`${BASE}/invoices`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      items(listInvoices(tx, scope, req.query)),
    ),
  );
  app.get(`${BASE}/invoices/:id`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope, p) =>
      invoiceDetail(tx, scope, idOf(p)),
    ),
  );
  app.post(`${BASE}/invoices/:id/void`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) =>
      voidInvoice(tx, scope, idOf(p), req.body as never),
    ),
  );
  app.post(`${BASE}/payments`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope) =>
      recordPayment(tx, scope, paymentBody(req.body) as never),
    ),
  );
  app.post(`${BASE}/payments/:id/void`, (req) =>
    inFinance(auth, req, FINANCE_WRITE, (tx, scope, p) =>
      voidPayment(tx, scope, idOf(p), req.body as never),
    ),
  );

  // Master data. Accounts are the owner's; the rest is finance.write.
  masterData("accounts", FINANCE_SETTINGS, {
    list: (tx, scope, query) => listAccounts(tx, scope, includeArchived(query)),
    create: createAccount,
    update: updateAccount,
    archive: archiveAccount,
    remove: deleteAccount,
  });
  masterData("categories", FINANCE_WRITE, {
    list: (tx, scope, query) =>
      listCategories(tx, scope, includeArchived(query)),
    create: createCategory,
    update: updateCategory,
    archive: archiveCategory,
    remove: deleteCategory,
  });
  masterData("cost-centers", FINANCE_WRITE, {
    list: (tx, scope, query) =>
      listCostCenters(tx, scope, includeArchived(query)),
    create: createCostCenter,
    update: updateCostCenter,
    archive: archiveCostCenter,
    remove: deleteCostCenter,
  });
  masterData("counterparties", FINANCE_WRITE, {
    list: (tx, scope, query) => {
      z.object({}).strict().parse(query);
      return listCounterparties(tx, scope);
    },
    create: createCounterparty,
    update: updateCounterparty,
    remove: deleteCounterparty,
  });
  masterData("recurring", FINANCE_WRITE, {
    list: (tx, scope, query) =>
      listRecurring(tx, scope, {
        includeInactive: inactiveQuery.parse(query).includeInactive === "true",
      }),
    create: createRecurring,
    update: updateRecurring,
    archive: archiveRecurring,
    remove: deleteRecurring,
  });

  // Mailboxes: which e-mail connections feed finance (owner only, like the
  // platform's mailbox view).
  app.get(`${BASE}/mailboxes`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, (tx, scope) =>
      items(mailboxesView(tx, scope)),
    ),
  );
  app.post(`${BASE}/mailboxes`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, (tx, scope) =>
      bindMailbox(tx, scope, req.body),
    ),
  );
  app.delete(`${BASE}/mailboxes/:id`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, async (tx, scope, p) => {
      const id = idOf(p);
      await unbindMailbox(tx, scope, id);
      return { id, unbound: true };
    }),
  );

  // Exchange rates.
  app.get(`${BASE}/fx-rates`, (req) =>
    inFinance(auth, req, FINANCE_READ, (tx, scope) =>
      items(listFxRates(tx, scope, req.query)),
    ),
  );
  app.post(`${BASE}/fx-rates`, (req) =>
    inFinance(auth, req, FINANCE_SETTINGS, async (tx, scope) => {
      const input = rateInput.parse(req.body);
      await setManualRate(tx, scope, input);
      // The currency names the row; the rate itself stays out of the audit.
      await audit(tx, scope, "finance.fx_rate.set", scope.projectId, {
        currency: input.currency,
      });
      return { ...input, source: "manual" };
    }),
  );

  // Exports: built and stored outside the gate's transaction (createExport
  // opens its own), so the gate runs first in a short one.
  app.get(`${BASE}/exports`, (req) =>
    inFinance(auth, req, FINANCE_EXPORT, (tx, scope) =>
      items(listExports(tx, scope)),
    ),
  );
  app.post(`${BASE}/exports`, { config: EXPORT_RATE }, async (req, reply) => {
    const scope = await financeScope(auth, req, FINANCE_EXPORT);
    const input = exportInput.parse(req.body);
    const result = await createExport(scope, {
      ...input,
      userId: scope.userId,
    });
    return reply.code(201).send(toJson(result));
  });
  app.get(`${BASE}/exports/:id/file`, async (req, reply) => {
    const scope = await financeScope(auth, req, FINANCE_EXPORT);
    const id = idOf(req.params as Params);
    const target = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      exportFile(tx, scope, id),
    );
    return sendFile(reply, scope, target.fileId, "attachment");
  });
};
