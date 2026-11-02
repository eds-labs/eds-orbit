// The social module's client side (ADR 0020): types of the /social API.

export type SocialApproval = "owner_each" | "editor_each";

/** GET /projects/:projectId/social/status */
export type SocialStatus = {
  module: "social";
  version: string;
  settings: { approval: SocialApproval; mcpOwnerPublishWithoutApproval: boolean };
  settingsVersion: number;
};

export const socialPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/social${rest}`;

export type SocialPlatform = "x" | "facebook" | "instagram" | "telegram";
export type SocialAccountStatus = "active" | "reconnect_required" | "disabled";

/** GET /projects/:projectId/social/accounts (never a token). */
export type SocialAccount = {
  id: string;
  platform: SocialPlatform;
  handle: string;
  displayName: string;
  status: SocialAccountStatus;
  capability: "configured" | "read_verified" | "write_verified";
  connectedAt: string;
  lastCheckedAt: string | null;
  lastCheckCode: string | null;
  version: number;
};
export type SocialAccounts = { items: SocialAccount[] };
