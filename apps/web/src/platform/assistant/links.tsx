"use client";
import { createContext, useContext, type ReactNode } from "react";
import Link from "next/link";
import { WorkspaceContext } from "@/components/workspace-context";

/**
 * Project-aware links of the assistant (WP3.8): the shell, which knows the
 * route table and the member's projects, resolves a card's in-app path in the
 * card's project. Without the shell (tests), "/p/<id>" plus the path is used.
 */
export type AssistantLinks = {
  hrefFor(projectId: string, href: string): string;
  projectName(projectId: string): string | undefined;
};

export const AssistantLinkContext = createContext<AssistantLinks | null>(null);

export function useAssistantLinks(): AssistantLinks {
  const links = useContext(AssistantLinkContext);
  const workspace = useContext(WorkspaceContext);
  if (links) return links;
  return {
    hrefFor: (projectId, href) =>
      workspace?.project.id === projectId
        ? workspace.href(href)
        : href.startsWith("/") && !href.startsWith("/p/")
          ? `/p/${encodeURIComponent(projectId)}${href}`
          : href,
    projectName: (projectId) =>
      workspace?.identity.projects.find((p) => p.id === projectId)?.name,
  };
}

/**
 * A link that opens in the card's project when it names one, else in the
 * open project (legacy paths) or as given.
 */
export function ProjectLink({
  projectId,
  href,
  children,
  className,
  onClick,
}: {
  projectId?: string;
  href: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  const links = useAssistantLinks();
  const workspace = useContext(WorkspaceContext);
  const target = projectId
    ? links.hrefFor(projectId, href)
    : workspace
      ? workspace.href(href)
      : href;
  return (
    <Link href={target} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}
