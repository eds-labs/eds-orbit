"use client";
import type { MarketingPlanSpec } from "../../../../../packages/schemas/src/marketing-plan";
import type {
  ActionRequestRenderer,
  ChatHost,
} from "@/platform/assistant/extensions";
import { useWorkspace } from "@/components/workspace-context";
import {
  useDecideActionRequest,
  type DecidableRequest,
} from "@/platform/assistant/decide";
import { Badge, Button } from "@/components/ui/primitives";
import {
  approvalModeText,
  deliveryText,
  scheduleText,
} from "./assignment-card";
export type PlanSnapshot = {
  id: string;
  revision: number;
  specHash: string;
  spec: MarketingPlanSpec;
  sourceSnapshot?: Array<{ id: string; version: number }>;
  linkedWork?: Array<{
    id: string;
    title: string | null;
    status: string | null;
    currentVersion: number | null;
    href: string;
    latestRun: { id: string; status: string; costMicros: number } | null;
  }>;
};
type Request = DecidableRequest & { status: string; expiresAt?: string };
export function PlanCard({
  plan,
  request,
  de,
  pending,
  canDecide,
  reviewed = false,
  blockers = [],
  onDecide,
}: {
  plan: PlanSnapshot;
  request?: Request | null;
  de: boolean;
  pending: boolean;
  canDecide: boolean;
  reviewed?: boolean;
  blockers?: string[];
  onDecide: (request: Request, decision: "approve" | "reject") => void;
}) {
  const s = plan.spec;
  const date = (iso: string) =>
    new Intl.DateTimeFormat(de ? "de-DE" : "en-GB", {
      timeZone: s.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  return (
    <section
      className="chat-proposal assignment-card"
      style={{ overflowWrap: "anywhere" }}
      aria-label={de ? "Marketingplan" : "Marketing plan"}
    >
      <div className="chat-proposal-head">
        <strong>{s.title}</strong>
        <Badge tone={blockers.length ? "warning" : "blue"}>
          {de ? "Vorgeschlagen · nicht aktiv" : "Proposed · not active"}
        </Badge>
      </div>
      <p>{s.goal}</p>
      <dl>
        <div>
          <dt>{de ? "Zielgruppe / Produkt" : "Audience / product"}</dt>
          <dd>
            {s.audience} · {s.productScope} · {s.campaignType}
          </dd>
        </div>
        <div>
          <dt>{de ? "Sprache / Zeitzone" : "Language / timezone"}</dt>
          <dd>
            {s.language} · {s.timezone}
          </dd>
        </div>
        <div>
          <dt>{de ? "Zeitraum" : "Horizon"}</dt>
          <dd>
            <time dateTime={s.horizon.startAt}>{date(s.horizon.startAt)}</time>{" "}
            – <time dateTime={s.horizon.endAt}>{date(s.horizon.endAt)}</time>
          </dd>
        </div>
        <div>
          <dt>{de ? "Rhythmus" : "Cadence"}</dt>
          <dd>{scheduleText(s.cadence, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Kanäle / Formate" : "Channels / types"}</dt>
          <dd>
            {s.channels.join(", ")} · {s.contentTypes.join(", ")}
          </dd>
        </div>
        <div>
          <dt>CTA</dt>
          <dd>
            {s.cta.label} · {s.cta.url}
          </dd>
        </div>
        <div>
          <dt>{de ? "Budgetprojektion" : "Budget projection"}</dt>
          <dd>
            {(s.monthlyBudgetMicros / 1000000).toLocaleString(
              de ? "de-DE" : "en-US",
              { style: "currency", currency: "USD", maximumFractionDigits: 6 },
            )}{" "}
            {de
              ? "pro Monat; keine zusätzliche Ausgabenfreigabe"
              : "per month; no additional spend authority"}
          </dd>
        </div>
        <div>
          <dt>{de ? "Freigabe" : "Approval"}</dt>
          <dd>{approvalModeText(s.approvalMode, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Zustellung" : "Delivery"}</dt>
          <dd>{deliveryText(s.delivery, de, s.approvalMode)}</dd>
        </div>
        <div>
          <dt>{de ? "Kreativrahmen" : "Creative scope"}</dt>
          <dd>
            {s.creative.image
              ? de
                ? "Mit Bild"
                : "With image"
              : de
                ? "Ohne Bild"
                : "Without image"}{" "}
            · {s.creative.styleAssetIds.join(", ") || "—"}
          </dd>
        </div>
      </dl>
      <h3>{de ? "Inhaltssäulen" : "Content pillars"}</h3>
      <ul>
        {s.pillars.map((p, i) => (
          <li key={i}>
            <strong>{p.title}</strong>: {p.angle}
          </li>
        ))}
      </ul>
      <h3>{de ? "Messgrößen" : "Measurements"}</h3>
      <ul>
        {s.kpis.map((k, i) => (
          <li key={i}>
            {k.name} ({k.unit}) ·{" "}
            {k.baselineState === "no_data"
              ? de
                ? "Keine Daten"
                : "No data"
              : de
                ? "Gespeicherte Messwerte"
                : "Stored measurements"}{" "}
            {k.metricRefs.map((r) => `${r.id} v${r.version}`).join(", ")}
          </li>
        ))}
      </ul>
      <h3>{de ? "Annahmen / offene Fragen" : "Assumptions / unknowns"}</h3>
      <ul>
        {[...s.assumptions, ...s.unknowns].map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
      <details>
        <summary>
          {de ? "Belege und verknüpfte Arbeit" : "Evidence and linked work"}
        </summary>
        <p>
          {de ? "Profilversion" : "Profile version"}: {s.profileVersion} ·
          Policy: {s.policy.id} v{s.policy.version}
        </p>
        <p>CTA fact: {s.cta.factId}</p>
        <ul>
          {s.facts.map((r) => (
            <li key={r.id}>
              Fact: {r.id} v{r.version}
            </li>
          ))}
          {(plan.sourceSnapshot ?? s.sourceRefs).map((r) => (
            <li key={r.id}>
              Source: {r.id} v{r.version}
            </li>
          ))}
        </ul>
        <ul>
          {s.existingWork.map((r) => (
            <li key={r.id}>
              {r.kind}: {r.id} v{r.version} ·{" "}
              {r.proposedChange ||
                (de ? "Unverändert referenziert" : "Referenced unchanged")}
            </li>
          ))}
        </ul>
        <p>
          Plan: {plan.id} · Revision {plan.revision} · {plan.specHash}
        </p>
      </details>
      {plan.linkedWork && plan.linkedWork.length > 0 && (
        <section aria-label={de ? "Bestehende Arbeit" : "Existing work"}>
          <h3>
            {de ? "Unabhängig laufende Arbeit" : "Independent existing work"}
          </h3>
          <ul>
            {plan.linkedWork.map((item) => (
              <li key={item.id}>
                <a href={item.href}>{item.title ?? item.id}</a> ·{" "}
                {item.status ?? (de ? "Nicht verfügbar" : "Unavailable")} ·{" "}
                {item.id} v{item.currentVersion ?? "?"}
                {item.latestRun && (
                  <p>
                    Run: {item.latestRun.id} · {item.latestRun.status}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {reviewed && (
        <p>
          {de
            ? "Diese Revision wurde strategisch freigegeben."
            : "This revision has strategic approval."}
        </p>
      )}
      {blockers.length > 0 && (
        <p role="status">
          {de ? "Blockiert" : "Blocked"}: {blockers.join(", ")}
        </p>
      )}
      <p className="chat-package-note">
        {de
          ? "Die Freigabe bestätigt nur diese Strategie. Der Plan wird nicht aktiv und startet keine Aufträge, KI-Ausgaben oder Veröffentlichungen. Die Aktivierung ist noch nicht verfügbar; Beiträge brauchen weiterhin ihre eigene Freigabe."
          : "Approval reviews this strategy only. The plan stays inactive and starts no assignments, AI spend or publishing. Activation is not available yet; posts still require their own approval."}
      </p>
      {request?.status === "pending" && canDecide && (
        <div className="chat-links">
          <Button
            disabled={pending || blockers.length > 0}
            onClick={() => onDecide(request, "approve")}
          >
            {de ? "Nur Strategie freigeben" : "Approve strategy only"}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onDecide(request, "reject")}
          >
            {de ? "Ablehnen" : "Reject"}
          </Button>
        </div>
      )}
      {request?.status === "pending" && !canDecide && (
        <p>{de ? "Wartet auf den Owner." : "Waiting for the owner."}</p>
      )}
    </section>
  );
}
export function ChatPlanCard({ card, host }: { card: any; host: ChatHost }) {
  const { isOwner, project } = useWorkspace();
  const decide = useDecideActionRequest();
  const shown = card.marketingPlan;
  if (!shown) return null;
  const live = host.conversation?.marketingPlans?.find(
    (p: any) => p.id === shown.id,
  );
  const own =
    live?.revision === shown.revision &&
    live?.actionRequest?.id === shown.actionRequest?.id
      ? live?.actionRequest
      : null;
  return (
    <>
      <PlanCard
        plan={{ ...shown, linkedWork: live?.linkedWork ?? shown.linkedWork }}
        request={own}
        de={host.de}
        pending={host.pending}
        canDecide={isOwner}
        reviewed={
          live?.revision === shown.revision && live?.strategicallyReviewed
        }
        blockers={live?.blockers}
        onDecide={(r, decision) => {
          void host.run(
            () => decide(r, decision).then(() => undefined),
            "Plan review failed",
          );
        }}
      />
      <p>
        <a href={`/p/${project.id}/marketing/plans?plan=${shown.id}`}>
          {host.de ? "Gespeicherten Plan öffnen" : "Open saved plan"}
        </a>
      </p>
    </>
  );
}
export const planReviewRenderer: ActionRequestRenderer = {
  accepts: (item) => Boolean(item.summary?.marketingPlan),
  component: ({ item, de, pending, decide }) => (
    <PlanCard
      plan={{
        ...item.summary.marketingPlan,
        id: item.summary.marketingPlan.planId,
      }}
      request={{ ...item, status: "pending" } as Request}
      de={de}
      pending={pending}
      canDecide
      onDecide={(_, decision) => decide(decision)}
    />
  ),
};
