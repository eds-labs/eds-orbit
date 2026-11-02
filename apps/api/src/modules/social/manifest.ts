import type { ServerModule } from "../../../../../packages/module-contracts/src/index.ts";
import { socialPermissions } from "./permissions.ts";

/**
 * The social module (ADR 0020): connected social accounts, posts with
 * per-account variants, media, the calendar, scheduling and publication
 * state, published directly to the platforms. Off for every project until
 * an owner enables it, and unreachable while ORBIT_SOCIAL is off.
 */
export const socialModule: ServerModule = {
  id: "social",
  version: "0.1.0",
  displayName: { en: "Social", de: "Social Media" },
  dependsOn: [],
  defaultEnabled: false,
  entityKinds: [],
  tables: [
    "SocialAccount",
    "SocialPost",
    "SocialPostVariant",
    "SocialPostMedia",
    "SocialPublication",
    "SocialDeliveryAttempt",
    "SocialAccountThrottle",
    "SocialOAuthState",
    "SocialMetricSnapshot",
    "SocialProviderState",
  ],
  permissions: socialPermissions,
};
