import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { DomainError } from "../../shared.ts";
import { financeFxSync } from "./fx.ts";
import { financeSwitchedOn } from "./gate.ts";
import { FINANCE_EXTRACT, FINANCE_MAIL_RECEIPT } from "./intake/documents.ts";
import { handleMailReceipt } from "./intake/mail.ts";
import { financeMailboxUse } from "./mailboxes.ts";

/** What the finance module plugs into the platform; later tasks add to it. */
export const financeContributions: ModuleContributions = {
  available: financeSwitchedOn,
  periodic: [financeFxSync],
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
    {
      queueClass: FINANCE_EXTRACT,
      // Replaced by the extraction handler; the code is permanent (NOT_).
      handler: async () => {
        throw new DomainError("FINANCE_EXTRACTION_NOT_IMPLEMENTED", 501);
      },
    },
  ],
};
