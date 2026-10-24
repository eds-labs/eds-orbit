import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { financeAttention } from "./attention.ts";
import { financeFxSync } from "./fx.ts";
import { runFinanceExtraction } from "./extraction/extract.ts";
import { financeSwitchedOn } from "./gate.ts";
import { FINANCE_EXTRACT, FINANCE_MAIL_RECEIPT } from "./intake/documents.ts";
import { handleMailReceipt } from "./intake/mail.ts";
import { financeMailboxUse } from "./mailboxes.ts";
import { financeMcpActions, financeMcpTools } from "./mcp-tools.ts";
import { financeUserNotifications } from "./notifications.ts";
import { financeRoutes } from "./routes.ts";
import { financeTools } from "./tools.ts";

/** What the finance module plugs into the platform; later tasks add to it. */
export const financeContributions: ModuleContributions = {
  available: financeSwitchedOn,
  unavailableCode: "FINANCE_DISABLED",
  routes: financeRoutes,
  periodic: [financeFxSync],
  // Assistant reads plus the MCP reads and the owner-approved retry
  // (mcp-tools.ts), which need the explicit orbit:finance.* scopes.
  tools: [...financeTools, ...financeMcpTools],
  actionTypes: financeMcpActions,
  attention: financeAttention,
  userNotifications: financeUserNotifications,
  // Receipts and exports are sensitive: only finance's own routes, with
  // their finance permissions, hand them out (never /files/:fileId).
  files: { privateToModule: true },
  // Mail of a mailbox bound to finance (mailboxes.ts) reaches only finance;
  // finance never takes the broadcast of unowned mailboxes.
  emailInbound: {
    queueClass: FINANCE_MAIL_RECEIPT,
    mailboxUse: financeMailboxUse,
    ownedOnly: true,
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
