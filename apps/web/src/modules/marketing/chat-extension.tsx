"use client";
import { MarketingAssistantNavigation } from "./marketing-entry";
import { marketingTemplates } from "./chat-templates";
import { RunOperationView, type RunOperation } from "./run-operation";
import { ChatPlanCard } from "./plan-card";
import { action, collectionPath, post } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import { useDecideActionRequest } from "@/platform/assistant/decide";
import type {
  ActionRequestRenderer,
  ChatExtension,
  ChatHost,
} from "@/platform/assistant/extensions";
import {
  PackageCard,
  packageInProgress,
  type ContentPackage,
} from "./chat-package-card";
import {
  AssignmentCard,
  type AssignmentContent,
  type AssignmentRequest,
} from "./assignment-card";

// Marketing's parts of the platform chat and approvals inbox (WP2.3), moved
// unchanged from chat.tsx and action-request-inbox.tsx: content packages,
// assignment cards and the owner's decisions on them.

const resultLabels: Record<string, [string, string]> = {
  planned: ["Preparation planned", "Vorbereitung geplant"],
  running: ["Preparing", "Wird vorbereitet"],
  done: ["Preparation complete", "Vorbereitung abgeschlossen"],
  partial: ["Partially prepared", "Teilweise vorbereitet"],
  failed: ["Failed", "Fehlgeschlagen"],
  canceled: ["Canceled", "Abgebrochen"],
  awaiting_owner: ["Awaiting your approval", "Wartet auf deine Freigabe"],
  scheduled: ["Scheduled in Orbit", "In Orbit eingeplant"],
  handed_over: [
    "Handed over; publication not confirmed",
    "Übergeben; Veröffentlichung unbestätigt",
  ],
  published: ["Published", "Veröffentlicht"],
  blocked: ["Blocked", "Blockiert"],
  stopped: ["Stopped", "Gestoppt"],
  withdrawn: ["Withdrawn", "Zurückgezogen"],
  dropped: ["Not scheduled", "Nicht eingeplant"],
  postiz_draft_pending: ["Postiz draft pending", "Postiz-Entwurf ausstehend"],
  postiz_draft: ["Draft created in Postiz", "Entwurf in Postiz erstellt"],
  postiz_draft_unknown: [
    "Postiz draft outcome unknown; reconciliation required",
    "Postiz-Ergebnis unklar; Abgleich erforderlich",
  ],
  postiz_draft_failed: ["Postiz draft failed", "Postiz-Entwurf fehlgeschlagen"],
};
const resultLabel = (value: string, de: boolean) =>
  resultLabels[value]?.[de ? 1 : 0] ?? value;

// Live state of an assignment a card names, read by its ID.
type LiveAssignment = AssignmentContent & {
  status: string;
  latestRun?: {
    operation?: RunOperation;
    id: string;
    date: string;
    status: string;
    costMicros: number;
    blockers: string[];
    deliverables: Array<{
      contentId: string;
      assetId?: string | null;
      channel: string;
      outcome: string;
      reason: string | null;
      publicationId: string | null;
      postizDraftId: string | null;
    }>;
  } | null;
  actionRequest: (AssignmentRequest & { expiresAt: string }) | null;
};

function ChatAssignmentCard({
  card,
  host,
}: {
  card: { assignment?: AssignmentContent & Record<string, any> };
  host: ChatHost;
}) {
  const { isOwner, project } = useWorkspace();
  const decide = useDecideActionRequest();
  if (!card.assignment) return null;
  const shown = card.assignment;
  const live = (
    host.conversation?.assignments as LiveAssignment[] | undefined
  )?.find((assignment) => assignment.id === shown.id);
  // Only the request this card was made for decides its content.
  const own =
    live?.actionRequest && live.actionRequest.id === shown.actionRequestId
      ? live.actionRequest
      : null;
  // The owner decides the exact assignment.confirm request the card shows.
  const decideAssignment = (
    request: AssignmentRequest,
    decision: "approve" | "reject",
    imageRightsConsent = false,
  ) => {
    if (!isOwner) return;
    return host.run(
      () =>
        decide(
          request,
          decision,
          decision === "approve" ? imageRightsConsent : undefined,
        ).then(() => undefined),
      "Decision failed",
    );
  };
  return (
    <>
      {live?.latestRun && (
        <section
          className="chat-proposal"
          aria-label={host.de ? "Auftragsergebnis" : "Assignment result"}
        >
          <strong>
            {host.de ? "Letzter Lauf" : "Latest run"}: {live.latestRun.date}
          </strong>
          <p>
            {resultLabel(live.latestRun.status, host.de)} ·{" "}
            {(live.latestRun.costMicros / 1_000_000).toLocaleString(
              host.de ? "de-DE" : "en-US",
              {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 6,
              },
            )}{" "}
            {host.de ? "erfasste KI-Kosten" : "recorded AI cost"}
          </p>
          <RunOperationView operation={live.latestRun.operation} de={host.de} />
          <p className="chat-package-note">Run: {live.latestRun.id}</p>
          {live.latestRun.blockers.length > 0 && (
            <p>
              {host.de ? "Blocker" : "Blockers"}:{" "}
              {live.latestRun.blockers.join(", ")}
            </p>
          )}
          <ul>
            {live.latestRun.deliverables.map((item) => (
              <li key={`${item.contentId}:${item.channel}`}>
                <strong>{item.channel}</strong>:{" "}
                {resultLabel(item.outcome, host.de)}
                {item.reason ? ` · ${item.reason}` : ""}
                <p className="chat-package-note">
                  Content: {item.contentId}
                  {item.assetId ? ` · Image: ${item.assetId}` : ""}
                  {item.publicationId
                    ? ` · Publication: ${item.publicationId}`
                    : ""}
                  {item.postizDraftId
                    ? ` · Postiz draft: ${item.postizDraftId}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
          <p>
            {host.de
              ? "Eine Übergabe oder ein Postiz-Entwurf ist noch keine Veröffentlichung."
              : "Handoff or a Postiz draft does not mean published."}
          </p>
          <div className="chat-links">
            <a href={`/p/${project.id}/approvals`}>
              {host.de ? "Beiträge prüfen" : "Review posts"}
            </a>
            <a href={`/p/${project.id}/marketing/assignments`}>
              {host.de ? "Aufträge verwalten" : "Manage assignments"}
            </a>
          </div>
        </section>
      )}
      <AssignmentCard
        assignment={{
          ...shown,
          channelNames: shown.channelNames ?? live?.channelNames,
        }}
        status={live?.status ?? shown.status ?? "draft"}
        request={own}
        expiresAt={own?.expiresAt}
        de={host.de}
        canDecide={isOwner}
        pending={host.pending}
        superseded={
          Boolean(live?.actionRequest) &&
          !own &&
          live?.actionRequest?.status === "pending"
        }
        onConfirm={(request, consent) =>
          void decideAssignment(request, "approve", consent)
        }
        onReject={(request) => void decideAssignment(request, "reject")}
      />
    </>
  );
}

function ChatPackages({ host }: { host: ChatHost }) {
  const { project, canEdit, isOwner } = useWorkspace();
  const decide = useDecideActionRequest();
  const de = host.de;
  const base = collectionPath(project.id, "chat");
  const packages = (host.conversation?.packages ?? []) as ContentPackage[];
  async function startPackage(pkg: ContentPackage) {
    if (!canEdit || !pkg.actionRequest) return;
    const request = pkg.actionRequest;
    await host.run(
      () => decide(request, "approve").then(() => undefined),
      "Start failed",
    );
  }
  // Owners confirm the generated image's usage rights with the existing asset decision.
  async function approveImageRights(pkg: ContentPackage) {
    if (!isOwner || !pkg.image?.assetId || !pkg.image.assetVersion) return;
    const image = pkg.image;
    await host.run(
      () =>
        action(project.id, "asset-status", {
          assetId: image.assetId,
          version: image.assetVersion,
          assetStatus: "approved",
          confirmUsageRights: true,
        }).then(() => undefined),
      "Approval failed",
    );
  }
  async function attachImage(pkg: ContentPackage, deliverableKeys: string[]) {
    if (!canEdit) return;
    await host.run(
      () =>
        post(`${base}/packages/${pkg.id}/attach-image`, {
          deliverableKeys,
        }).then(() => undefined),
      "Attaching failed",
    );
  }
  // Stops a post before the handoff; a handed-over post is reported, never retracted.
  async function unschedule(pkg: ContentPackage, deliverableKey: string) {
    if (!canEdit) return;
    await host.run(async () => {
      const result = await post<{ result: string }>(
        `${base}/packages/${pkg.id}/unschedule`,
        { deliverableKey },
      );
      if (result.result === "not_retractable")
        return de
          ? "Der Beitrag wurde bereits übergeben und kann nicht zurückgeholt werden."
          : "The post was already handed over and cannot be taken back.";
      if (result.result === "handoff_in_progress")
        return de
          ? "Der Beitrag wird gerade übergeben; das Ergebnis wird abgeglichen."
          : "The post is being handed over right now; the result will be reconciled.";
    }, "Cancel failed");
  }
  async function cancelPackage(pkg: ContentPackage) {
    if (!canEdit) return;
    await host.run(
      () => post(`${base}/packages/${pkg.id}/cancel`, {}).then(() => undefined),
      "Cancel failed",
    );
  }
  return (
    <>
      {packages.map((pkg) => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          de={de}
          canStart={canEdit}
          pending={host.pending}
          onStart={startPackage}
          onCancel={cancelPackage}
          canApproveRights={isOwner}
          onApproveRights={approveImageRights}
          onAttachImage={attachImage}
          onUnschedule={unschedule}
        />
      ))}
    </>
  );
}

export const marketingChat: ChatExtension = {
  navigation: MarketingAssistantNavigation,
  templates: marketingTemplates,
  messageCards: {
    assignment: ChatAssignmentCard,
    marketing_plan: ChatPlanCard,
  },
  afterMessages: ChatPackages,
  busy: (conversation) =>
    Boolean(
      (conversation.assignments as LiveAssignment[] | undefined)?.some((item) =>
        ["planned", "running"].includes(item.latestRun?.status ?? ""),
      ) ||
      (conversation.packages as ContentPackage[] | undefined)?.some(
        packageInProgress,
      ),
    ),
};

/** The owner confirms or rejects a proposed assignment in the inbox. */
export const assignmentConfirmRenderer: ActionRequestRenderer = {
  accepts: (item) => Boolean(item.summary?.assignment),
  component: ({ item, de, pending, decide }) => (
    <AssignmentCard
      assignment={item.summary.assignment}
      status="draft"
      request={{ ...(item as AssignmentRequest), status: "pending" }}
      expiresAt={item.expiresAt}
      de={de}
      canDecide
      pending={pending}
      onConfirm={(_, consent) => decide("approve", consent)}
      onReject={() => decide("reject")}
    />
  ),
};
