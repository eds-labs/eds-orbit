"use client";
import { useContext } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, MessageCircle } from "lucide-react";
import type { MarketingPlanView } from "../../../../../packages/schemas/src/marketing-plan";
import { useWorkspace } from "@/components/workspace-context";
import { ShellContext } from "@/platform/shell/shell-context";
import { storeAssistantDraft } from "@/platform/shell/assistant-draft";
import { AppLink } from "@/platform/ui/app-link";
import { collectionPath, useResource } from "@/lib/api";
import { Button, Empty, Skeleton } from "@/components/ui/primitives";
import { ResourceError } from "@/platform/ui/collection";
import { SavedPlanList } from "./plan-navigation";
import { marketingTemplates } from "./chat-templates";

/** Presentation only; all mutations retain server-side current-role checks. */
export function useMarketingAccess() {
  const workspace = useWorkspace();
  const shell = useContext(ShellContext);
  const module = shell?.modules?.find((item) => item.id === "marketing");
  const visible = !module || (module.enabled && module.access !== "none");
  const role = module?.access;
  const enabled = visible && shell?.features?.agents === true;
  return {
    enabled,
    canEdit:
      enabled &&
      (role ? role === "owner" || role === "editor" : workspace.canEdit),
    isOwner: enabled && (role ? role === "owner" : workspace.isOwner),
  };
}

/** Opens an editable, project-bound draft. Never sends a message or starts work. */
export function PlanInAssistantButton({ planId }: { planId?: string }) {
  const { project, locale } = useWorkspace();
  const { canEdit } = useMarketingAccess();
  const router = useRouter();
  const de = locale === "de";
  if (!canEdit) return null;
  return (
    <Button
      onClick={() => {
        const text = planId
          ? de
            ? `Lade den aktuellen gespeicherten Marketingplan ${planId} für ${project.name}. Prüfe Status, Quellen, Budget und bestehende Arbeit. Schlage nötige Änderungen oder konkrete Aufträge als separat freizugebenden Entwurf vor. Erteile keine Freigabe, starte keine Arbeit und veröffentliche nichts.`
            : `Load the current saved marketing plan ${planId} for ${project.name}. Check status, sources, budget and existing work. Propose needed changes or exact assignments as a draft requiring separate approval. Grant no approval, start no work and publish nothing.`
          : marketingTemplates({
              projectName: project.name,
              de,
              canEdit: true,
              features: { agents: true },
            })[0]!.prompt;
        storeAssistantDraft(project.id, text);
        router.push(`/p/${project.id}/assistant`);
      }}
    >
      <MessageCircle aria-hidden="true" />
      {planId
        ? de
          ? "Im Assistant weiterplanen"
          : "Continue planning in assistant"
        : de
          ? "Mit Assistant planen"
          : "Plan with assistant"}
    </Button>
  );
}

export function MarketingManualLinks() {
  const { project, locale } = useWorkspace();
  const de = locale === "de";
  const { enabled } = useMarketingAccess();
  const root = `/p/${project.id}/marketing`;
  return (
    <nav
      className="marketing-manual-links"
      aria-label={
        de ? "Manuelle Marketing-Werkzeuge" : "Manual marketing tools"
      }
    >
      <span>{de ? "Manuell arbeiten:" : "Work manually:"}</span>
      <AppLink href={`${root}/content`}>
        Creator / {de ? "Inhalte" : "Content"}
      </AppLink>
      <AppLink href={`${root}/missions`}>
        {de ? "Missionen" : "Missions"}
      </AppLink>
      {enabled && (
        <AppLink href={`${root}/assignments`}>
          {de ? "Aufträge" : "Assignments"}
        </AppLink>
      )}
    </nav>
  );
}

/** Marketing's contribution to the one shared Assistant. No extra fetch or state. */
export function MarketingAssistantNavigation() {
  const { project, locale } = useWorkspace();
  const { enabled } = useMarketingAccess();
  if (!enabled) return null;
  const de = locale === "de";
  return (
    <nav
      className="marketing-assistant-nav"
      aria-label={de ? "Marketing im Assistant" : "Marketing in the assistant"}
    >
      <AppLink href={`/p/${project.id}/marketing/plans`}>
        {de ? "Gespeicherte Pläne" : "Saved plans"}
      </AppLink>
      <AppLink href={`/p/${project.id}/approvals`}>
        {de ? "Beiträge freigeben" : "Review posts"}
      </AppLink>
      <AppLink href={`/p/${project.id}/marketing/analytics#marketing-reports`}>
        {de ? "Berichte" : "Reports"}
      </AppLink>
      <AppLink href={`/p/${project.id}/marketing/content`}>Creator</AppLink>
    </nav>
  );
}

/** An honest entry flow; its numbered links are steps, never completion claims. */
export function MarketingStart({ compact = false }: { compact?: boolean }) {
  const { project, locale, revision } = useWorkspace();
  const { enabled, canEdit } = useMarketingAccess();
  const de = locale === "de";
  const plans = useResource<{ items: MarketingPlanView[]; truncated: boolean }>(
    enabled && !compact
      ? collectionPath(project.id, `marketing-plans?revision=${revision}`)
      : null,
  );
  if (!enabled || plans.error?.status === 404) return null;
  return (
    <section
      className={`marketing-start${compact ? " marketing-start-compact" : ""}`}
      aria-label={de ? "Marketing mit Orbit" : "Marketing with Orbit"}
    >
      <div className="marketing-start-head">
        <div>
          <h2>
            {de ? "Marketing mit Orbit planen" : "Plan marketing with Orbit"}
          </h2>
          <p>
            {de
              ? "Ziel und Budget klären, Plan prüfen, Beiträge bewusst freigeben."
              : "Clarify goals and budget, review the plan, then approve individual posts."}
          </p>
        </div>
        {canEdit ? (
          <PlanInAssistantButton />
        ) : (
          <Button asChild variant="outline">
            <AppLink href={`/p/${project.id}/assistant`}>
              {de ? "Assistant öffnen" : "Open assistant"}
            </AppLink>
          </Button>
        )}
      </div>
      <nav aria-label={de ? "Marketing-Schritte" : "Marketing steps"}>
        <ol className="marketing-steps">
          {[
            [
              "assistant",
              de ? "Im Assistant beginnen" : "Start in assistant",
              de ? "Ziel, Zeitraum, Budget" : "Goal, horizon, budget",
            ],
            [
              "marketing/plans",
              de ? "Gespeicherten Plan prüfen" : "Review saved plan",
              de
                ? "Strategie und Aufträge separat"
                : "Strategy and assignments separately",
            ],
            [
              "approvals",
              de ? "Beiträge freigeben" : "Review posts",
              de
                ? "Inhalte vor externer Übergabe"
                : "Content before external handoff",
            ],
          ].map(([path, title, detail], i) => (
            <li key={path}>
              <AppLink href={`/p/${project.id}/${path}`}>
                <span className="marketing-step-number" aria-hidden="true">
                  {i + 1}
                </span>
                <span>
                  {title}
                  <small>{detail}</small>
                </span>
                <ArrowRight aria-hidden="true" />
              </AppLink>
            </li>
          ))}
        </ol>
      </nav>
      {!compact && (
        <>
          <p className="marketing-entry-note">
            {de
              ? "Eine Strategiefreigabe startet noch keine Aufträge. Jeder neue Beitrag braucht standardmäßig deine Freigabe vor der externen Übergabe."
              : "Strategy approval alone starts no assignments. Each new post requires your approval before external handoff by default."}
          </p>
          <ResourceError error={plans.error} retry={plans.refresh} />
          {plans.loading ? (
            <Skeleton />
          ) : (
            plans.data &&
            (plans.data.items.length ? (
              <SavedPlanList
                plans={plans.data.items.slice(0, 3)}
                projectId={project.id}
                de={de}
              />
            ) : (
              <Empty
                title={
                  de ? "Noch kein gespeicherter Plan" : "No saved plan yet"
                }
                description={
                  de
                    ? "Beginne im Assistant. Ein Vorschlag wird separat geprüft."
                    : "Start in the assistant. A proposal is reviewed separately."
                }
              />
            ))
          )}
          <MarketingManualLinks />
        </>
      )}
    </section>
  );
}
