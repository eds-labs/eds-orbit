"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { MarketingPlanView } from "../../../../../packages/schemas/src/marketing-plan";
import { collectionPath, useResource, useMutation } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { useDecideActionRequest } from "@/platform/assistant/decide";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead } from "@/platform/ui/collection";
import { Alert, Button } from "@/components/ui/primitives";
import { PlanCard } from "./plan-card";
export function MarketingPlansPage() {
  const { project, locale } = useWorkspace();
  return (
    <Suspense
      fallback={
        <p role="status">{locale === "de" ? "Wird geladen…" : "Loading…"}</p>
      }
    >
      <ProjectPlans key={project.id} />
    </Suspense>
  );
}
function ProjectPlans() {
  const { project, locale, isOwner } = useWorkspace();
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
            ? "Dauerhaft gespeicherte Strategievorschläge. Noch keine automatische Ausführung."
            : "Saved strategic proposals. Automatic execution is not available yet."
        }
      >
        {selected && (
          <Button asChild variant="outline">
            <AppLink href={`/p/${project.id}/marketing/plans`}>
              {de ? "Alle Pläne" : "All plans"}
            </AppLink>
          </Button>
        )}
        <Button asChild variant="outline">
          <AppLink href="/chat">
            {de
              ? "Im Chat vorschlagen oder ändern"
              : "Propose or change in chat"}
          </AppLink>
        </Button>
      </PageHead>
      {(plans.error || detail.error || mutation.error) && (
        <Alert kind="error">
          {plans.error?.message ?? detail.error?.message ?? mutation.error}
        </Alert>
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
      {!selected && (
        <ul>
          {plans.data?.items.map((p) => (
            <li key={p.id}>
              <a href={`/p/${project.id}/marketing/plans?plan=${p.id}`}>
                {p.spec.title}
              </a>{" "}
              · {p.status} · Revision {p.revision}
            </li>
          ))}
        </ul>
      )}
      {plans.data?.truncated && (
        <p>
          {de
            ? "Die neuesten 20 Pläne werden angezeigt."
            : "Showing the latest 20 plans."}
        </p>
      )}
      {detail.data && (
        <>
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
