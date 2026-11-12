import { sameHref } from "./routes";
import { settingsSectionHref } from "./settings-nav";
import type { ShellContextValue } from "./shell-context";

export type ShellLinks = Required<
  Pick<
    ShellContextValue,
    "settingsHref" | "connectionsHref" | "organizationSettingsHref" | "centerLink"
  >
>;

/**
 * The shell's links to settings (settings center phase 5). Unless the flag
 * is on they are today's addresses, byte for byte; with "on" an old address
 * goes through `map` (the shell's mapping to the center), which keeps the
 * old address whenever it cannot decide, so a link never leads nowhere.
 */
export function shellLinks({
  stage,
  hrefOf,
  map,
}: {
  stage: "off" | "preview" | "on" | undefined;
  /** The URL of a page in the project (ShellContextValue.hrefOf). */
  hrefOf: (key: string) => string;
  map: (href: string) => string;
}): ShellLinks {
  const link = stage === "on" ? map : sameHref;
  return {
    settingsHref: (key) => link(settingsSectionHref(hrefOf("settings"), key)),
    connectionsHref: () => link(hrefOf("connectors")),
    organizationSettingsHref: (organizationId) =>
      link(`/o/${encodeURIComponent(organizationId)}/settings`),
    centerLink: link,
  };
}
