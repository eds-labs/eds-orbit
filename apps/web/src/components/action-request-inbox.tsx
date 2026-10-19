"use client";
import Image from "next/image";
import { useContext, useState } from "react";
import { collectionPath, useResource, usd } from "@/lib/api";
import { Alert, Badge, Button } from "./ui/primitives";
import { useWorkspace } from "./workspace-context";
import { useDecideActionRequest } from "@/platform/assistant/decide";
import { ShellContext } from "@/platform/shell/shell-context";

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

type Requester = { kind: string; userId: string; clientId?: string };

/** The host of an MCP client's id (a URL), else the id as written; null for other requesters. */
export function mcpClientHost(requestedBy: Requester) {
  if (requestedBy.kind !== "mcp" || !requestedBy.clientId) return null;
  try {
    return new URL(requestedBy.clientId).hostname || requestedBy.clientId;
  } catch {
    return requestedBy.clientId;
  }
}

/** Where an MCP proposal came from, as plain text, so the owner knows before deciding. */
export function RequestedViaMcp({
  requestedBy,
  de,
}: {
  requestedBy: Requester;
  de: boolean;
}) {
  const host = mcpClientHost(requestedBy);
  if (!host) return null;
  return (
    <p className="chat-package-note">
      {de ? "über MCP-Client" : "via MCP client"} {host}
    </p>
  );
}

type ActionRequestItem = {
  id: string;
  version: number;
  actionType: string;
  packageHash: string;
  costCeilingMicros: number;
  expiresAt: string;
  requestedBy: Requester;
  summary: {
    task?: { description: string; mode: string; modules: string[] };
    operation?: Record<string, unknown>;
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
    assignment?: Record<string, any>;
  };
};

/**
 * The text of a failed decision: a short sentence for codes an owner can act
 * on, otherwise the error's own message (the code in words).
 */
export function decisionErrorText(cause: unknown, de: boolean) {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code: unknown }).code
      : undefined;
  if (code === "MCP_GRANT_ENDED")
    return de
      ? "Die App, die das vorgeschlagen hat, darf nicht mehr vorschlagen (Verbindung getrennt, Vorschläge gestoppt oder Zugriff geändert). Du kannst den Vorschlag nur noch ablehnen."
      : "The app that proposed this may no longer propose (it was disconnected, its proposals were stopped or its access changed). You can only reject it now.";
  return cause instanceof Error
    ? cause.message
    : de
      ? "Entscheidung fehlgeschlagen"
      : "Decision failed";
}

/** Owners decide open action requests here, for example an editor's package image. */
export function ActionRequestInbox() {
  const { locale, project, isOwner } = useWorkspace();
  const de = locale === "de";
  const requests = useResource<{ items: ActionRequestItem[] }>(
    isOwner ? collectionPath(project.id, "action-requests") : null,
  );
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const decideRequest = useDecideActionRequest();
  // Views modules contribute for their action types (WP2.3).
  const renderers = useContext(ShellContext)?.actionRequests ?? {};
  async function decide(
    item: ActionRequestItem,
    decision: "approve" | "reject",
    imageRightsConsent?: boolean,
  ) {
    setPending(item.id);
    setError("");
    try {
      await decideRequest(item, decision, imageRightsConsent);
      requests.refresh();
    } catch (cause) {
      setError(decisionErrorText(cause, de));
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
      {items.map((item) => {
        const view = renderers[item.actionType];
        return view?.accepts(item) ? (
          <div key={item.id}>
            <RequestedViaMcp requestedBy={item.requestedBy} de={de} />
            <view.component
              item={item}
              de={de}
              pending={Boolean(pending)}
              decide={(decision, consent) =>
                void decide(item, decision, consent)
              }
            />
          </div>
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
            <RequestedViaMcp requestedBy={item.requestedBy} de={de} />
            {item.summary.task && (
              <div>
                <p>{item.summary.task.description}</p>
                <p>
                  {item.summary.task.modules.join(", ")} ·{" "}
                  {item.summary.task.mode}
                </p>
              </div>
            )}
            {item.summary.operation && (
              <details>
                <summary>
                  {de ? "Genaue Änderung prüfen" : "Review exact change"}
                </summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(item.summary.operation, null, 2)}
                </pre>
              </details>
            )}
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
        );
      })}
    </section>
  );
}
