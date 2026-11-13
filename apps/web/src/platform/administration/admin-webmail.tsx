"use client";
import { useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Badge } from "@/components/ui/primitives";

// Installation status of webmail (ADR 0026): control-plane metadata only.

export type WebmailAdminStatus = {
  enabled: boolean;
  originConfigured: boolean;
  bridge: "ok" | "unreachable" | "off";
};

const BRIDGE = {
  ok: { tone: "success", en: "reachable", de: "erreichbar" },
  unreachable: { tone: "danger", en: "not reachable", de: "nicht erreichbar" },
  off: { tone: "neutral", en: "off", de: "aus" },
} as const;

export function WebmailStatusView({
  status,
  locale,
}: {
  status: WebmailAdminStatus;
  locale: Locale;
}) {
  const de = locale === "de";
  const yes = de ? "ja" : "yes";
  const no = de ? "nein" : "no";
  const bridge = BRIDGE[status.bridge];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Webmail</h2>
          <p>
            {de
              ? "Zustand der Installation; Postfächer und Inhalte erscheinen hier nicht."
              : "State of the installation; mailboxes and content do not appear here."}
          </p>
        </div>
      </div>
      <dl className="detail-grid">
        <dt>{de ? "Eingeschaltet" : "Enabled"}</dt>
        <dd>
          <Badge tone={status.enabled ? "success" : "neutral"}>
            {status.enabled ? yes : no}
          </Badge>
        </dd>
        <dt>{de ? "Origin eingerichtet" : "Origin configured"}</dt>
        <dd>
          <Badge tone={status.originConfigured ? "success" : "neutral"}>
            {status.originConfigured ? yes : no}
          </Badge>
        </dd>
        <dt>Bridge</dt>
        <dd>
          <Badge tone={bridge.tone}>{bridge[locale]}</Badge>
        </dd>
      </dl>
    </section>
  );
}

/** Nothing while it loads or where the server does not offer the status. */
export function WebmailStatusPanel({ locale }: { locale: Locale }) {
  const status = useResource<WebmailAdminStatus>("/admin/webmail/status");
  return status.data ? (
    <WebmailStatusView status={status.data} locale={locale} />
  ) : null;
}
