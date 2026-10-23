import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { financeAttention } from "./attention.ts";
import { financeFxSync } from "./fx.ts";
import { runFinanceExtraction } from "./extraction/extract.ts";
import { financeSwitchedOn } from "./gate.ts";
import { FINANCE_EXTRACT, FINANCE_MAIL_RECEIPT } from "./intake/documents.ts";
import { handleMailReceipt } from "./intake/mail.ts";
import { financeMailboxUse } from "./mailboxes.ts";
import { financeUserNotifications } from "./notifications.ts";
import { financeRoutes } from "./routes.ts";
import { financeTools } from "./tools.ts";

/** What the finance module plugs into the platform; later tasks add to it. */
export const financeContributions: ModuleContributions = {
  available: financeSwitchedOn,
  routes: financeRoutes,
  periodic: [financeFxSync],
  tools: financeTools,
  attention: financeAttention,
  userNotifications: financeUserNotifications,
  // Mail of a mailbox bound to finance (mailboxes.ts) reaches only finance.
  emailInbound: {
    queueClass: FINANCE_MAIL_RECEIPT,
    mailboxUse: financeMailboxUse,
  },
  jobs: [
    {
      queueClass: FINANCE_MAIL_RECEIPT,
      handler: ({ scope, job }) => handleMailReceipt(scope, job.resourceId),
    },
    // A paid call: an attempt that sent it is never repeated (extract.ts).
    {
      queueClass: FINANCE_EXTRACT,
      leaseMs: 180_000,
      handler: ({ scope, job, jobId }) =>
        runFinanceExtraction(scope, {
          documentId: job.resourceId,
          attemptKey: jobId,
        }),
    },
  ],
};
