import { permission } from "../../platform/tenancy/permissions.ts";

// Finance permissions (spec §12). All sensitive: financial records, so no
// module role can grant them beyond the defaults without an explicit choice.
const sensitive = (def: ReturnType<typeof permission>) => ({
  ...def,
  sensitive: true,
});

export const FINANCE_READ = sensitive(
  permission("finance.read", "Read finance documents, entries and reports", [
    "owner",
    "editor",
  ]),
);
export const FINANCE_WRITE = sensitive(
  permission("finance.write", "Review documents and book entries", [
    "owner",
    "editor",
  ]),
);
export const FINANCE_EXPORT = sensitive(
  permission("finance.export", "Export the journal and documents", [
    "owner",
    "editor",
  ]),
);
// Owner-only: base currency, AI extraction consent and mailbox bindings.
export const FINANCE_SETTINGS = sensitive(
  permission("finance.settings", "Manage finance settings", ["owner"]),
);

export const financePermissions = [
  FINANCE_READ,
  FINANCE_WRITE,
  FINANCE_EXPORT,
  FINANCE_SETTINGS,
];
