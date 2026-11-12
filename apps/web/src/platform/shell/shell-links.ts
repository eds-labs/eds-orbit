import { manageHref } from "@/platform/settings-center/routes";
import { settingsSectionHref } from "./settings-nav";
import type { ShellContextValue } from "./shell-context";

export type ShellLinks = Required<
  Pick<
    ShellContextValue,
    "settingsHref" | "connectionsHref" | "organizationSettingsHref" | "centerLink"
  >
>;

const same = (href: string) => href;

/**
 * The shell's links to settings (settings center phase 5). Unless the flag
 * is on they are today's addresses, byte for byte; with "on" an old address
 * goes through `map` (the shell's mapping to the center), which keeps the
 * old address whenever it cannot decide, so a link never leads nowhere.
 */
export function shellLinks({
  stage,
  projectId,
  hrefOf,
  map,
}: {
  stage: "off" | "preview" | "on" | undefined;
  projectId: string;
  /** The URL of a page in the project (ShellContextValue.hrefOf). */
  hrefOf: (key: string) => string;
  map: (href: string) => string;
}): ShellLinks {
  const on = stage === "on";
  const link = on ? map : same;
  return {
    settingsHref: (key) => link(settingsSectionHref(hrefOf("settings"), key)),
    // The old connectors page maps to the integrations catalog; its own
    // panel, the connections, is a section of the center's integrations.
    connectionsHref: () =>
      on
        ? manageHref({ kind: "project", projectId }, "integrations", "connections")
        : hrefOf("connectors"),
    organizationSettingsHref: (organizationId) =>
      link(`/o/${encodeURIComponent(organizationId)}/settings`),
    centerLink: link,
  };
}
