import type { ModuleContributions } from "../../platform/modules/contributions.ts";
import { webmailSwitchedOn } from "./gate.ts";

/** What the webmail module plugs into the platform. */
export const webmailContributions: ModuleContributions = {
  available: webmailSwitchedOn,
  unavailableCode: "WEBMAIL_DISABLED",
};
