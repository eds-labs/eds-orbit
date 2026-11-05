"use client";
import { useState } from "react";
import Image from "next/image";
import { Check, ExternalLink, FolderKanban, X } from "lucide-react";
import { Alert, Badge, Button } from "@/components/ui/primitives";
import { chatErrorOf } from "@/components/chat-errors";
import type { ChatCard } from "./api";
import { useDecideActionRequest } from "./decide";
import { ProjectLink, useAssistantLinks } from "./links";

// Generic chat cards with their project (WP3.5, WP3.8): a project badge,
// links that open in the card's project, and Approve / Reject for an action
// request the member may decide from the card. Everything else links to the
// project's approvals page, where the full renderer decides.

const KIND: Record<string, [string, string]> = {
  source: ["Source", "Quelle"],
  asset: ["Asset", "Asset"],
  link: ["Link", "Link"],
  status: ["Status", "Status"],
  assignment: ["Assignment", "Auftrag"],
  marketing_plan: ["Plan", "Plan"],
};

/** How a card's action request is decided: on the card, by link, or not at all. */
export function decisionMode(card: ChatCard): "inline" | "link" | null {
  const request = card.actionRequest;
  if (!request) return null;
  return card.kind === "status" && request.decidable && request.inline
    ? "inline"
    : "link";
}

export function ProjectBadge({
  projectId,
  projectName,
}: {
  projectId?: string;
  projectName?: string;
}) {
  const links = useAssistantLinks();
  const name =
    projectName ?? (projectId ? links.projectName(projectId) : undefined);
  if (!name) return null;
  return (
    <span className="project-badge" title={name}>
      <FolderKanban aria-hidden="true" />
      <span>{name}</span>
    </span>
  );
}

function DecideButtons({
  card,
  de,
  onDecided,
}: {
  card: ChatCard & { actionRequest: NonNullable<ChatCard["actionRequest"]> };
  de: boolean;
  onDecided?: () => void;
}) {
  const decide = useDecideActionRequest(card.projectId);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState("");
  async function run(decision: "approve" | "reject") {
    setPending(true);
    setError("");
    try {
      await decide(card.actionRequest, decision);
      setDone(decision);
      onDecided?.();
    } catch (cause) {
      setError(chatErrorOf(cause, de));
    } finally {
      setPending(false);
    }
  }
  if (done)
    return (
      <Badge tone={done === "approve" ? "success" : "neutral"}>
        {done === "approve"
          ? de
            ? "Freigegeben"
            : "Approved"
          : de
            ? "Abgelehnt"
            : "Rejected"}
      </Badge>
    );
  return (
    <>
      <div className="chat-card-actions">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => void run("approve")}
        >
          <Check aria-hidden="true" />
          {de ? "Freigeben" : "Approve"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void run("reject")}
        >
          <X aria-hidden="true" />
          {de ? "Ablehnen" : "Reject"}
        </Button>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
    </>
  );
}

/** One generic card: kind or status, project, link, preview, decision. */
export function ChatCardView({
  card,
  de,
  onDecided,
}: {
  card: ChatCard;
  de: boolean;
  onDecided?: () => void;
}) {
  const links = useAssistantLinks();
  const mode = decisionMode(card);
  const projectName =
    card.projectName ??
    (card.projectId ? links.projectName(card.projectId) : undefined);
  return (
    <div className="chat-card">
      <div className="chat-card-head">
        <Badge
          tone={
            card.status === "stale"
              ? "warning"
              : card.kind === "asset"
                ? "blue"
                : "neutral"
          }
        >
          {card.status === "stale"
            ? de
              ? "Veraltet"
              : "Stale"
            : (KIND[card.kind]?.[de ? 1 : 0] ?? card.kind)}
        </Badge>
        <ProjectBadge
          projectId={card.projectId}
          projectName={card.projectName}
        />
      </div>
      {card.href ? (
        <ProjectLink projectId={card.projectId} href={card.href}>
          <ExternalLink aria-hidden="true" />
          {card.label}
        </ProjectLink>
      ) : (
        <span>{card.label}</span>
      )}
      {card.kind === "asset" && card.status === "approved" && card.href && (
        <Image
          unoptimized
          src={card.href}
          width={160}
          height={100}
          alt={card.label}
        />
      )}
      {mode === "inline" && card.actionRequest && (
        <DecideButtons
          card={{ ...card, actionRequest: card.actionRequest }}
          de={de}
          onDecided={onDecided}
        />
      )}
      {mode === "link" && (
        <ProjectLink
          projectId={card.projectId}
          href="/decisions"
          className="chat-card-approvals"
        >
          {projectName
            ? de
              ? `Freigaben in ${projectName} öffnen`
              : `Open approvals in ${projectName}`
            : de
              ? "Freigaben öffnen"
              : "Open approvals"}
        </ProjectLink>
      )}
    </div>
  );
}
