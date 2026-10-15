"use client";
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

// Live state of an assignment a card names, read by its ID.
type LiveAssignment = AssignmentContent & {
  status: string;
  actionRequest: (AssignmentRequest & { expiresAt: string }) | null;
};

function ChatAssignmentCard({
  card,
  host,
}: {
  card: { assignment?: AssignmentContent & Record<string, any> };
  host: ChatHost;
}) {
  const { isOwner } = useWorkspace();
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
  messageCards: { assignment: ChatAssignmentCard },
  afterMessages: ChatPackages,
  busy: (conversation) =>
    Boolean(
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
