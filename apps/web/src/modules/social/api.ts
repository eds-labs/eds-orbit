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
