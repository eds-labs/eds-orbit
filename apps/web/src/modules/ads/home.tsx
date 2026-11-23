"use client";

import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { WidgetResource } from "@/platform/ui/widget-resource";
import { adsPath, type AdAccountView } from "./api";

export function AdsHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  return (
    <WidgetResource<{ accounts: AdAccountView[] }>
      id="home-card-ads"
      title={de ? "Werbekonten" : "Ad accounts"}
      href={shell.hrefOf("ads.accounts")}
      path={adsPath(project.id, "/accounts")}
    >
      {({ accounts }) => {
        const active = accounts.filter(
          ({ status }) => status === "active",
        ).length;
        return accounts.length ? (
          <dl className="home-counts">
            <div>
              <dt>{de ? "Verknüpft" : "Linked"}</dt>
              <dd>{accounts.length}</dd>
            </div>
            <div>
              <dt>{de ? "Aktiv" : "Active"}</dt>
              <dd>{active}</dd>
            </div>
            <div data-tone={active < accounts.length ? "warning" : undefined}>
              <dt>{de ? "Prüfbedarf" : "Needs attention"}</dt>
              <dd>{accounts.length - active}</dd>
            </div>
          </dl>
        ) : (
          <p>
            {de ? "Keine Werbekonten verknüpft." : "No ad accounts are linked."}
          </p>
        );
      }}
    </WidgetResource>
  );
}
