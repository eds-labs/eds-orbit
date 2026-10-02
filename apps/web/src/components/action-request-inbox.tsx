"use client";
import { useState } from "react";
import { collectionPath, post, useResource, usd } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";

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
    packageGoal?: string | null;
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
  ) {
    setPending(item.id);
    setError("");
    try {
      await post(
        collectionPath(project.id, `action-requests/${item.id}/decide`),
        { version: item.version, packageHash: item.packageHash, decision },
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
      {items.map((item) => (
        <article key={item.id} className="action-request">
          <div className="chat-proposal-head">
            <strong>
              {item.actionType === "image.generate"
                ? de
                  ? "Bild erzeugen"
                  : "Generate image"
                : item.actionType}
            </strong>
            <Badge tone="warning">
              {de ? "höchstens" : "at most"} {usd(item.costCeilingMicros)}
            </Badge>
          </div>
          {item.summary.packageGoal && (
            <p>
              {de ? "Paket" : "Package"}: {item.summary.packageGoal}
            </p>
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
              {new Date(item.expiresAt).toLocaleString(de ? "de-DE" : "en-GB")}
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
      ))}
    </section>
  );
}
