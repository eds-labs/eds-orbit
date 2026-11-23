"use client";

import { useWorkspace } from "@/components/workspace-context";
import { useShell } from "@/platform/shell/shell-context";
import { WidgetResource } from "@/platform/ui/widget-resource";
import { webmailPath, type MailboxesResponse } from "./api";

export function WebmailHome() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const de = locale === "de";
  return (
    <WidgetResource<MailboxesResponse>
      id="home-card-webmail"
      title={de ? "Freigegebene Postfächer" : "Shared mailboxes"}
      href={shell.hrefOf("webmail")}
      path={webmailPath(project.id, "/mailboxes")}
    >
      {({ mailboxes }) => {
        const ready = mailboxes.filter(
          ({ status, sync }) => status === "ok" && sync === "ok",
        ).length;
        return mailboxes.length ? (
          <dl className="home-counts">
            <div>
              <dt>{de ? "Freigegeben" : "Shared"}</dt>
              <dd>{mailboxes.length}</dd>
            </div>
            <div>
              <dt>{de ? "Bereit" : "Ready"}</dt>
              <dd>{ready}</dd>
            </div>
            <div data-tone={ready < mailboxes.length ? "warning" : undefined}>
              <dt>{de ? "Prüfbedarf" : "Needs attention"}</dt>
              <dd>{mailboxes.length - ready}</dd>
            </div>
          </dl>
        ) : (
          <p>
            {de
              ? "Für dich sind keine Postfächer freigegeben."
              : "No mailboxes are shared with you."}
          </p>
        );
      }}
    </WidgetResource>
  );
}
