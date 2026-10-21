"use client";
import type { MarketingPlanView } from "../../../../../packages/schemas/src/marketing-plan";
import { AppLink } from "@/platform/ui/app-link";
import { Badge } from "@/components/ui/primitives";

/** Descriptive next step only; the native plan/release services authorize actions. */
export function planNextStep(plan: MarketingPlanView, de: boolean) {
  if (plan.blockers.length)
    return de ? "Voraussetzungen prüfen" : "Check prerequisites";
  if (plan.status === "completed") return de ? "Abgeschlossen" : "Completed";
  if (plan.status === "paused")
    return de
      ? "Pausiert – Wiederaufnahme separat bestätigen"
      : "Paused — resumption needs separate approval";
  if (plan.actionRequest?.status === "pending")
    return de ? "Strategie wartet auf Freigabe" : "Strategy awaits approval";
  if (plan.activationRequest?.status === "pending")
    return de
      ? "Konkrete Aufträge warten auf Freigabe"
      : "Exact assignments await approval";
  if (plan.status === "active")
    return de
      ? "Aktiv – Beiträge separat prüfen"
      : "Active — review posts separately";
  if (plan.strategicallyReviewed)
    return de
      ? "Aufträge im Assistant vorbereiten"
      : "Prepare assignments in the assistant";
  return de ? "Strategieentwurf prüfen" : "Review strategy proposal";
}

export function SavedPlanList({
  plans,
  projectId,
  de,
}: {
  plans: MarketingPlanView[];
  projectId: string;
  de: boolean;
}) {
  return (
    <ul className="marketing-plan-list">
      {plans.map((plan) => (
        <li key={plan.id}>
          <AppLink href={`/p/${projectId}/marketing/plans?plan=${plan.id}`}>
            <span className="marketing-plan-title">{plan.spec.title}</span>
            <Badge tone={plan.blockers.length ? "warning" : "neutral"}>
              Revision {plan.revision}
            </Badge>
            <span className="marketing-plan-next">
              {planNextStep(plan, de)}
            </span>
          </AppLink>
        </li>
      ))}
    </ul>
  );
}
