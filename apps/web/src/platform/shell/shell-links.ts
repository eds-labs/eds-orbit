import { manageHref } from "@/platform/settings-center/routes";
import { settingsSectionHref } from "./settings-nav";
import type { ShellContextValue } from "./shell-context";

export type ShellLinks = Required<
  Pick<
    ShellContextValue,
    | "settingsHref"
    | "connectionsHref"
    | "organizationSettingsHref"
    | "projectCenterHref"
    | "centerLink"
  >
>;

/**
 * The shell's links to settings (settings center phase 5). An old address
 * goes through `map` (the shell's mapping to the center), which keeps the
 * old address whenever it cannot decide, so a link never leads nowhere.
 */
export function shellLinks({
  hrefOf,
  projectId,
  map,
}: {
  /** The URL of a page in the project (ShellContextValue.hrefOf). */
  hrefOf: (key: string) => string;
  /** The open project. */
  projectId: string;
  map: (href: string) => string;
}): ShellLinks {
  const link = map;
  return {
    settingsHref: (key) => link(settingsSectionHref(hrefOf("settings"), key)),
    connectionsHref: () => link(hrefOf("connectors")),
    organizationSettingsHref: (organizationId) =>
      link(`/o/${encodeURIComponent(organizationId)}/settings`),
    // A center address is final: it is never mapped.
    projectCenterHref: (area, ...rest) =>
      manageHref({ kind: "project", projectId }, area, ...rest),
    centerLink: link,
  };
}
