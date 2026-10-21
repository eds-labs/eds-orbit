"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { AppLink } from "@/platform/ui/app-link";
import { useWorkspace } from "@/components/workspace-context";
import { useResource, useMutation, post } from "@/lib/api";
import { Alert, Button, Input, Loading } from "@/components/ui/primitives";
type Group = {
  source: string;
  days: number;
  freshness: string;
  report: string;
  accountId: string | null;
  currency: string | null;
  timezone: string | null;
  sessions: number | null;
  clicks: number | null;
  impressions: number | null;
  conversions: number | null;
  complete: boolean;
  overlap: boolean;
};
export type PeriodicReport = {
  id: string;
  version: number;
  planId: string;
  revision: number;
  status: string;
  noData: boolean;
  complete: boolean;
  acknowledgedRevision: number;
  period: { from: string; to: string; timezone: string };
  projectReports: Group[];
  planReports: Group[];
  limitations: string[];
  coverage: {
    periodCoverageEstablished?: boolean;
    requestedChannels: string[];
    specialistMaxChannels: number;
    specialistMaxPosts: number;
    specialistRecentDays: number;
  };
  attribution: {
    proposedLink: { url: string; conflict: boolean };
    appliedToContent: boolean;
  };
  revisionProposal: { status: string; proposedPlanId?: string } | null;
};
const number = (v: number | null) => (v === null ? "—" : v.toLocaleString());
export function ReportEvidence({
  report: r,
  de,
}: {
  report: PeriodicReport;
  de: boolean;
}) {
  const groups = (rows: Group[]) =>
    rows.length ? (
      <ul>
        {rows.map((g, index) => (
          <li key={index}>
            <strong>
              {g.source} · {g.report || "—"}
            </strong>{" "}
            · {g.currency ?? "—"} · {g.timezone ?? "—"}
            <p style={{ overflowWrap: "anywhere" }}>{g.accountId ?? "—"}</p>
            <p>
              {de ? "Sitzungen" : "Sessions"}: {number(g.sessions)} ·{" "}
              {de ? "Klicks" : "Clicks"}: {number(g.clicks)} ·{" "}
              {de ? "Einblendungen" : "Impressions"}: {number(g.impressions)} ·{" "}
              {de ? "Conversions" : "Conversions"}: {number(g.conversions)}
            </p>
            <p>
              {de ? "Beobachtete Tage" : "Observed days"}: {g.days} ·{" "}
              {de ? "Stand" : "Freshness"}: {g.freshness}
            </p>
            {!g.complete && (
              <p>
                {de ? "Abdeckung unvollständig" : "Incomplete coverage"}
                {g.overlap ? " · overlapping periods" : ""}
              </p>
            )}
          </li>
        ))}
      </ul>
    ) : (
      <p>{de ? "Keine Messdaten" : "No measurements"}</p>
    );
  return (
    <>
      <h3>
        {r.period.from} – {r.period.to} · {r.period.timezone} ·{" "}
        {de ? "Revision" : "Revision"} {r.revision}
      </h3>
      <p>
        {r.status === "invalidated"
          ? de
            ? "Messdaten geändert; Bericht muss aktualisiert werden"
            : "Measurements changed; report needs refreshing"
          : r.noData
            ? de
              ? "Keine dem Plan zugeordneten Messdaten"
              : "No plan-attributed measurements"
            : de
              ? "Dem Plan zugeordnete Messungen"
              : "Plan-attributed measurements"}
        {!r.complete
          ? de
            ? " · Unvollständige Abdeckung"
            : " · Incomplete coverage"
          : ""}
      </p>
      <p>
        {de
          ? "Vollständige Periodenabdeckung nicht belegt; fehlende Messungen sind keine Nullen."
          : "Full-period coverage is not established; missing measurements are not zeros."}
      </p>
      <h4>{de ? "Planmessungen" : "Plan measurements"}</h4>
      {groups(r.planReports)}
      <h4>
        {de
          ? "Projektmessungen nach Quelle (keine Plansummen)"
          : "Project measurements by source (not plan totals)"}
      </h4>
      {groups(r.projectReports)}
      <p>
        {de ? "Analytics-Stichprobe" : "Analytics sample"}:{" "}
        {Math.min(
          r.coverage.specialistMaxChannels,
          r.coverage.requestedChannels.length,
        )}{" "}
        / {r.coverage.requestedChannels.length}{" "}
        {de ? "Kanäle maximal" : "channels at most"} ·{" "}
        {r.coverage.specialistMaxPosts}{" "}
        {de ? "Posts pro Aufgabe" : "posts per task"} ·{" "}
        {r.coverage.specialistRecentDays} {de ? "Tage" : "days"}
      </p>
      <details>
        <summary>
          {de ? "Grenzen und Attribution" : "Limitations and attribution"}
        </summary>
        <ul>
          {r.limitations.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <p>
          {de
            ? "Linkvorschlag für künftige Inhalte; noch nicht angewendet"
            : "Proposed link for future content; not applied"}
        </p>
        <p className="prose" style={{ overflowWrap: "anywhere" }}>
          {r.attribution.proposedLink.url}
        </p>
        {r.attribution.proposedLink.conflict && (
          <p>
            {de
              ? "Vorhandene Kampagnenparameter beibehalten"
              : "Existing campaign parameters retained"}
          </p>
        )}
      </details>
    </>
  );
}
export function PeriodicReports() {
  const { project, locale, isOwner, canEdit, refresh } = useWorkspace(),
    de = locale === "de";
  const resource = useResource<{ items: PeriodicReport[]; truncated: boolean }>(
    `/projects/${project.id}/marketing-reports`,
  );
  const plans = useResource<{
    items: Array<{ id: string; spec: { title: string } }>;
  }>(canEdit ? `/projects/${project.id}/marketing-plans` : null);
  const selectedId = useSearchParams().get("report");
  const selected = useResource<PeriodicReport>(
    selectedId
      ? `/projects/${project.id}/marketing-reports/${encodeURIComponent(selectedId)}`
      : null,
  );
  const items = resource.data?.items ?? [];
  const shown = selected.data
    ? [selected.data, ...items.filter((r) => r.id !== selected.data!.id)]
    : items;
  const mutation = useMutation(() => {
    resource.refresh();
    selected.refresh();
    refresh();
  });
  const [planId, setPlanId] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  if (resource.error?.code === "AGENTS_DISABLED") return null;
  return (
    <section
      className="panel marketing-reports"
      aria-label={de ? "Marketing-Berichte" : "Marketing reports"}
    >
      <h2>{de ? "Marketing-Berichte" : "Marketing reports"}</h2>
      <p>
        {de
          ? "Abgeschlossene lokale Wochen werden für aktive Pläne automatisch ausgewertet. Berichte verändern keine Aufträge."
          : "Closed local weeks are reported automatically for active plans. Reports do not change assignments."}
      </p>
      {resource.loading && <Loading />}
      {selected.error && <Alert kind="error">{selected.error.message}</Alert>}
      {resource.error && <Alert kind="error">{resource.error.message}</Alert>}
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {canEdit && (
        <form
          className="marketing-report-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(() =>
              post(`/projects/${project.id}/marketing-reports`, {
                planId,
                from,
                to,
              }),
            );
          }}
        >
          <label>
            {de ? "Plan" : "Plan"}
            <select
              className="input"
              required
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              <option value="">
                {de ? "Plan auswählen" : "Choose a plan"}
              </option>
              {plans.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.spec.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            {de ? "Von" : "From"}
            <Input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            {de ? "Bis (abgeschlossen)" : "To (closed)"}
            <Input
              type="date"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <Button disabled={mutation.pending} type="submit">
            {de
              ? "Bericht erstellen / aktualisieren"
              : "Create / refresh report"}
          </Button>
        </form>
      )}
      {resource.data?.items.length === 0 && (
        <p>
          {de ? "Noch keine periodischen Berichte" : "No periodic reports yet"}
        </p>
      )}
      {shown.map((r) => (
        <article key={r.id} id={`report-${r.id}`}>
          <ReportEvidence report={r} de={de} />
          <AppLink href={`/p/${project.id}/marketing/plans?plan=${r.planId}`}>
            {de ? "Ursprungsplan" : "Original plan"}
          </AppLink>
          {isOwner &&
            r.status === "ready" &&
            r.acknowledgedRevision !== r.revision && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    post(
                      `/projects/${project.id}/marketing-reports/${r.id}/acknowledge`,
                      { version: r.version },
                    ),
                  )
                }
              >
                {de ? "Bericht gelesen" : "Mark report read"}
              </Button>
            )}
          {canEdit &&
            r.status === "ready" &&
            r.revisionProposal &&
            !r.revisionProposal.proposedPlanId && (
              <Button
                disabled={mutation.pending}
                onClick={() =>
                  mutation.run(() =>
                    post(
                      `/projects/${project.id}/marketing-reports/${r.id}/proposal`,
                      { version: r.version },
                    ),
                  )
                }
              >
                {de
                  ? "Planrevision als Vorschlag vorbereiten"
                  : "Prepare proposed plan revision"}
              </Button>
            )}
          {r.revisionProposal?.proposedPlanId && (
            <AppLink
              href={`/p/${project.id}/marketing/plans?plan=${r.revisionProposal.proposedPlanId}`}
            >
              {de
                ? "Vorgeschlagene Revision prüfen"
                : "Review proposed revision"}
            </AppLink>
          )}
        </article>
      ))}
      {resource.data?.truncated && (
        <p>
          {de ? "Nur die letzten 20 Berichte" : "Showing the latest 20 reports"}
        </p>
      )}
    </section>
  );
}
