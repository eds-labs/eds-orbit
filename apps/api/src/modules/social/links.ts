import { projectCenterLink } from "../../platform/management/links.ts";

/** The Social accounts section of the settings center (an integration section). */
export const socialAccountsLink = (projectId: string) =>
  projectCenterLink(projectId, "integrations", "social", "accounts");
