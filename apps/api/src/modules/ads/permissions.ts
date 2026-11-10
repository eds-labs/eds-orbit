import { permission } from "../../platform/tenancy/permissions.ts";

// Ads module permissions (ADR 0025). Viewers see nothing: spend and account
// data are sensitive, so reading is owner and editor work. Approving spend,
// connecting accounts and budgets stay with the owner.
const sensitive = (def: ReturnType<typeof permission>) => ({
  ...def,
  sensitive: true,
});

export const ADS_READ = sensitive(
  permission("ads.read", "Read ad accounts, campaigns and reports", [
    "owner",
    "editor",
  ]),
);
export const ADS_ANALYTICS_READ = sensitive(
  permission("ads.analytics.read", "Read ad performance figures and spend", [
    "owner",
    "editor",
  ]),
);
export const ADS_COMPOSE = permission(
  "ads.compose",
  "Create and edit ad drafts",
  ["owner", "editor"],
);
export const ADS_MANAGE = permission(
  "ads.manage",
  "Manage campaigns and ads",
  ["owner", "editor"],
);
export const ADS_APPROVE = sensitive(
  permission("ads.approve", "Approve ad launches and spend changes", ["owner"]),
);
// Connecting and disconnecting accounts handles their tokens.
export const ADS_ACCOUNTS_MANAGE = sensitive(
  permission("ads.accounts.manage", "Connect, check and disconnect ad accounts", [
    "owner",
  ]),
);
export const ADS_BUDGET_MANAGE = sensitive(
  permission("ads.budget.manage", "Set and change ad budgets", ["owner"]),
);
export const ADS_SETTINGS = permission(
  "ads.settings",
  "Manage the ads module's settings",
  ["owner"],
);

export const adsPermissions = [
  ADS_READ,
  ADS_ANALYTICS_READ,
  ADS_COMPOSE,
  ADS_MANAGE,
  ADS_APPROVE,
  ADS_ACCOUNTS_MANAGE,
  ADS_BUDGET_MANAGE,
  ADS_SETTINGS,
];
