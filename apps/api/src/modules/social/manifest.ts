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
  // MCP media idempotency receipts and upload sessions (media/mcp-tools.ts,
  // media/upload-sessions.ts): ids, hashes and state only, no image bytes.
  entityKinds: [
    {
      kind: "social_media_receipt",
      description: "Idempotency receipts of MCP media imports and uploads",
      exported: false,
    },
    {
      kind: "social_media_upload",
      description: "One-time MCP media upload sessions",
      exported: false,
    },
  ],
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
    "SocialMediaAsset",
  ],
  permissions: socialPermissions,
};
