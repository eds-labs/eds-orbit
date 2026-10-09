"use client";
import Image from "next/image";
import { useState } from "react";
import { collectionPath, post, useResource, usd } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { AssignmentCard, type AssignmentContent } from "./assignment-card";
import { useWorkspace } from "./workspace-context";

const platforms: Record<string, string> = {
  x: "X",
  telegram: "Telegram",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
};
// The channel as the owner knows it; the ID only when it is no longer assigned.
export function channelLabel(summary: {
  channel?: string;
  channelName?: string | null;
  channelPlatform?: string | null;
}) {
  if (!summary.channelName) return summary.channel ?? "";
  const platform = summary.channelPlatform
    ? (platforms[summary.channelPlatform] ?? summary.channelPlatform)
    : null;
  return platform
    ? `${summary.channelName} (${platform})`
    : summary.channelName;
}

type ActionRequestItem = {
  id: string;
  version: number;
  actionType: string;
  packageHash: string;
  costCeilingMicros: number;
  expiresAt: string;
  requestedBy: { kind: string; userId: string };
  summary: {
    prompt?: string;
    model?: string;
    maxCostMicros?: number;
    size?: string;
    quality?: string;
    channel?: string;
    channelName?: string | null;
    channelPlatform?: string | null;
    scheduledAt?: string;
    body?: string;
    executionMode?: "test" | "live";
    assetId?: string | null;
    packageGoal?: string | null;
    // `assignment.confirm`: the exact assignment the owner confirms.
    assignment?: AssignmentContent;
  };
};

/** Owners decide open action requests here, for example an editor's package image. */
export function ActionRequestInbox() {
  const { locale, project, isOwner } = useWorkspace();
  const de = locale === "de";
  const requests = useResource<{ items: ActionRequestItem[] }>(
    isOwner ? collectionPath(project.id, "action-requests") : null,
  );
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  async function decide(
    item: ActionRequestItem,
    decision: "approve" | "reject",
    imageRightsConsent?: boolean,
  ) {
    setPending(item.id);
    setError("");
    try {
      await post(
        collectionPath(project.id, `action-requests/${item.id}/decide`),
        {
          version: item.version,
          packageHash: item.packageHash,
          decision,
          ...(imageRightsConsent === undefined ? {} : { imageRightsConsent }),
        },
      );
      requests.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Decision failed");
    } finally {
      setPending("");
    }
  }
  const items = requests.data?.items ?? [];
  if (!isOwner || !items.length) return null;
  return (
    <section
      className="panel action-request-inbox"
      aria-label={de ? "Offene Freigaben" : "Open decisions"}
    >
      <h2>{de ? "Offene Freigaben" : "Open decisions"}</h2>
      {error && <Alert kind="error">{error}</Alert>}
      {items.map((item) =>
        item.actionType === "assignment.confirm" && item.summary.assignment ? (
          <AssignmentCard
            key={item.id}
            assignment={item.summary.assignment}
            status="draft"
            request={{ ...item, status: "pending" }}
            expiresAt={item.expiresAt}
            de={de}
            canDecide
            pending={Boolean(pending)}
            onConfirm={(_, consent) => decide(item, "approve", consent)}
            onReject={() => decide(item, "reject")}
          />
        ) : (
          <article key={item.id} className="action-request">
            <div className="chat-proposal-head">
              <strong>
                {item.actionType === "image.generate"
                  ? de
                    ? "Bild erzeugen"
                    : "Generate image"
                  : item.actionType === "content.schedule"
                    ? de
                      ? "Beitrag terminieren"
                      : "Schedule post"
                    : item.actionType}
              </strong>
              {item.actionType === "content.schedule" ? (
                <Badge
                  tone={
                    item.summary.executionMode === "live" ? "danger" : "warning"
                  }
                >
                  {item.summary.executionMode === "live"
                    ? de
                      ? "Öffentlicher Beitrag"
                      : "Public post"
                    : de
                      ? "Testmodus"
                      : "Test mode"}
                </Badge>
              ) : (
                <Badge tone="warning">
                  {de ? "höchstens" : "at most"} {usd(item.costCeilingMicros)}
                </Badge>
              )}
            </div>
            {item.summary.packageGoal && (
              <p>
                {de ? "Paket" : "Package"}: {item.summary.packageGoal}
              </p>
            )}
            {item.summary.scheduledAt && (
              <p>
                {channelLabel(item.summary)} ·{" "}
                <time dateTime={item.summary.scheduledAt}>
                  {new Date(item.summary.scheduledAt).toLocaleString(
                    de ? "de-DE" : "en-GB",
                  )}
                </time>
              </p>
            )}
            {item.summary.body && (
              <>
                <blockquote className="chat-package-draft">
                  {item.summary.body}
                </blockquote>
                {item.summary.assetId && (
                  <Image
                    unoptimized
                    src={`/api/projects/${project.id}/assets/${item.summary.assetId}/content`}
                    width={160}
                    height={160}
                    alt={de ? "Bild des Beitrags" : "Post image"}
                  />
                )}
                <p className="chat-package-note">
                  {de
                    ? "Mit der Freigabe bestätigst du genau diesen Text und Termin. Alle Prüfungen laufen direkt vor der Übergabe erneut."
                    : "Approving confirms exactly this text and slot. All checks run again right before the handoff."}
                </p>
              </>
            )}
            {item.summary.prompt && (
              <blockquote className="chat-package-draft">
                {item.summary.prompt}
              </blockquote>
            )}
            <p className="chat-package-note">
              {[item.summary.model, item.summary.size, item.summary.quality]
                .filter(Boolean)
                .join(" · ")}{" "}
              · {de ? "gültig bis" : "valid until"}{" "}
              <time dateTime={item.expiresAt}>
                {new Date(item.expiresAt).toLocaleString(
                  de ? "de-DE" : "en-GB",
                )}
              </time>
            </p>
            <div className="chat-links">
              <Button
                onClick={() => decide(item, "approve")}
                disabled={Boolean(pending)}
              >
                {de ? "Freigeben" : "Approve"}
              </Button>
              <Button
                variant="outline"
                onClick={() => decide(item, "reject")}
                disabled={Boolean(pending)}
              >
                {de ? "Ablehnen" : "Reject"}
              </Button>
            </div>
          </article>
        ),
      )}
    </section>
  );
}
