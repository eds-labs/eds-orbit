import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { adsPermissions } from "./permissions.ts";

/** The module id; the gate and the route base use this constant. */
export const ADS_MODULE_ID = "ads";

/**
 * The ads module (ADR 0025): connected ad accounts, campaigns, budgets and
 * reporting for paid advertising. Off for every project until an owner
 * enables it, and unreachable while ORBIT_ADS is off.
 */
export const adsModule: ServerModule = {
  id: ADS_MODULE_ID,
  version: "0.1.0",
  displayName: { en: "Ads", de: "Werbung" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: ["AdAccount", "AdOAuthState", "AdProviderThrottle", "AdSyncState"],
  permissions: adsPermissions,
};
