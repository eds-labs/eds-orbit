"use client";
import { useContext, type ComponentProps } from "react";
import Link from "next/link";
import { WorkspaceContext } from "@/components/workspace-context";

/**
 * A link inside the current project. Paths from before WP1.7 ("/content",
 * "/approvals", also sent by the API in chat cards) point to the page in the
 * open project instead of taking the redirect.
 */
export function AppLink({ href, ...props }: ComponentProps<typeof Link>) {
  const workspace = useContext(WorkspaceContext);
  const target =
    typeof href === "string" && workspace?.href ? workspace.href(href) : href;
  return <Link href={target} {...props} />;
}
