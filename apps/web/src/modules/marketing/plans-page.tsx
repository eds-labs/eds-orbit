"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { MarketingPlanView } from "../../../../../packages/schemas/src/marketing-plan";
import { collectionPath, useResource, useMutation, post } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { useDecideActionRequest } from "@/platform/assistant/decide";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead } from "@/platform/ui/collection";
import { Alert, Button } from "@/components/ui/primitives";
import { PlanCard, PlanActivationCard } from "./plan-card";
import {
  PlanInAssistantButton,
  MarketingManualLinks,
  useMarketingAccess,
} from "./marketing-entry";
import { SavedPlanList, planNextStep } from "./plan-navigation";
import { ResourceError } from "@/platform/ui/collection";
export function MarketingPlansPage() {
  const { project, locale } = useWorkspace();
  const { enabled } = useMarketingAccess();
  if (!enabled)
    return (
      <>
        <PageHead
          title={locale === "de" ? "Marketingpläne" : "Marketing plans"}
          description={
            locale === "de"
              ? "Gespeicherte Strategien und getrennte Freigaben."
              : "Saved strategies and separate approvals."
          }
        />
        <Alert>
          {locale === "de"
            ? "Marketingpläne sind aktuell nicht verfügbar. Die manuellen Werkzeuge bleiben erreichbar."
            : "Marketing plans are currently unavailable. Manual tools remain accessible."}
        </Alert>
        <MarketingManualLinks />
      </>
    );
  return (
    <div className="marketing-plans-page">
      <Suspense
        fallback={
          <p role="status">{locale === "de" ? "Wird geladen…" : "Loading…"}</p>
        }
      >
        <ProjectPlans key={project.id} />
      </Suspense>
    </div>
  );
}
function ProjectPlans() {
  const { project, locale } = useWorkspace();
  const { isOwner, canEdit } = useMarketingAccess();
  const de = locale === "de";
  const search = useSearchParams();
  const id = search.get("plan");
  const selected = id && /^[a-f0-9-]{36}$/i.test(id) ? id : "";
  const base = collectionPath(project.id, "marketing-plans");
  const plans = useResource<{ items: MarketingPlanView[]; truncated: boolean }>(
    base,
  );
  const detail = useResource<MarketingPlanView>(
    selected ? `${base}/${selected}` : null,
  );
  const mutation = useMutation(() => {
    plans.refresh();
    detail.refresh();
  });
  const decide = useDecideActionRequest();
  return (
    <>
      <PageHead
        title={de ? "Marketingpläne" : "Marketing plans"}
        description={
          de
            ? "Gespeicherte Strategien mit separat freigegebenen Aufträgen."
            : "Saved strategies with separately approved assignments."
        }
      >
        {selected && (
          <Button asChild variant="outline">
            <AppLink href={`/p/${project.id}/marketing/plans`}>
              {de ? "Alle Pläne" : "All plans"}
            </AppLink>
          </Button>
        )}
        {canEdit && <PlanInAssistantButton planId={selected || undefined} />}
      </PageHead>
      <MarketingManualLinks />
      <ResourceError
        error={selected ? detail.error : plans.error}
        retry={selected ? detail.refresh : plans.refresh}
      />
      {mutation.error && <Alert kind="error">{mutation.error}</Alert>}
      {selected && detail.loading && (
        <p role="status">{de ? "Plan wird geladen…" : "Loading plan…"}</p>
      )}
      {plans.loading && (
        <p role="status">{de ? "Wird geladen…" : "Loading…"}</p>
      )}
      {!selected && plans.data?.items.length === 0 && (
        <p>
          {de
            ? "Noch kein Marketingplan. Beschreibe im Chat Ziel, Zeitraum und Budget."
            : "No marketing plan yet. Describe the goal, horizon and budget in chat."}
        </p>
      )}
      {!selected && plans.data && (
        <SavedPlanList
          plans={plans.data.items}
          projectId={project.id}
          de={de}
        />
      )}
      {!selected && plans.data?.truncated && (
        <p>
          {de
            ? "Die neuesten 20 Pläne werden angezeigt."
            : "Showing the latest 20 plans."}
        </p>
      )}
      {detail.data && (
        <>
          <section
            className="marketing-plan-guidance"
            aria-label={de ? "Nächster Schritt" : "Next step"}
          >
            <h2>{planNextStep(detail.data, de)}</h2>
            <p>
              {de
                ? "Strategie, konkrete Aufträge und einzelne Beiträge werden getrennt freigegeben."
                : "Strategy, exact assignments and individual posts have separate approvals."}
            </p>
            <nav aria-label={de ? "Zum Plan" : "Plan navigation"}>
              <AppLink href={`/p/${project.id}/approvals`}>
                {de ? "Beiträge prüfen" : "Review posts"}
              </AppLink>
              <AppLink
                href={`/p/${project.id}/marketing/analytics#marketing-reports`}
              >
                {de ? "Berichte prüfen" : "Review reports"}
              </AppLink>
              <AppLink href={`/p/${project.id}/decisions`}>
                {de ? "Alle App-Freigaben" : "All app approvals"}
              </AppLink>
            </nav>
          </section>
          <PlanCard
            plan={detail.data}
            request={detail.data.actionRequest}
            de={de}
            pending={mutation.pending}
            canDecide={isOwner}
            reviewed={detail.data.strategicallyReviewed}
            blockers={detail.data.blockers}
            onDecide={(r, decision) => {
              void mutation.run(() => decide(r, decision));
            }}
          />
          {detail.data.activationRequest && (
            <PlanActivationCard
              key={detail.data.activationRequest.id}
              request={detail.data.activationRequest}
              payload={detail.data.activationRequest.payload}
              de={de}
              pending={mutation.pending}
              canDecide={isOwner}
              blockers={detail.data.blockers}
              onDecide={(decision, consent) => {
                void mutation.run(() =>
                  decide(detail.data!.activationRequest!, decision, consent),
                );
              }}
            />
          )}
          {isOwner &&
            detail.data.activation &&
            (detail.data.status === "active" ||
              detail.data.status === "blocked") && (
              <Button
                variant="outline"
                disabled={mutation.pending}
                onClick={() => {
                  void mutation.run(() =>
                    post(`${base}/${detail.data!.id}/pause`, {
                      version: detail.data!.version,
                    }),
                  );
                }}
              >
                {de ? "Plan pausieren" : "Pause plan"}
              </Button>
            )}
          {detail.data.activationAvailable && (
            <p>
              {de
                ? "Konkrete Aufträge oder die Wiederaufnahme im Chat vorschlagen; der Owner bestätigt die vollständige Fassung separat."
                : "Propose exact assignments or resumption in chat; the owner separately approves the complete mandate."}
            </p>
          )}
          <p>
            <a href={`/api${base}/${detail.data.id}/export`} download>
              {de
                ? "Plan und Versionshistorie exportieren"
                : "Export plan and version history"}
            </a>
          </p>
        </>
      )}
    </>
  );
}
