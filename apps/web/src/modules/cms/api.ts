// The content module's client side (ADR 0029): types of the /cms API.

export type CmsSettings = {
  publishApprovers: "owner" | "owner_or_editor";
  fourEyes: boolean;
  timeZone: string | null;
  lateWindowHours: number;
};

/** GET /projects/:projectId/cms/status */
export type CmsStatus = {
  module: "cms";
  version: string;
  settings: CmsSettings;
  settingsVersion: number;
};

export const cmsPath = (projectId: string, rest = "") =>
  `/projects/${encodeURIComponent(projectId)}/cms${rest}`;
