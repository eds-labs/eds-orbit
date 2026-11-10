"use client";
import { useContext } from "react";
import { AppLink } from "@/platform/ui/app-link";
import { ShellContext } from "@/platform/shell/shell-context";
import type { ApprovalState, OriginRef } from "./api";
import { socialText } from "./labels";

// Where a post came from (WP3, 2026-11-10). A post Marketing announced or
// handed over was released by the owner in Marketing (owner release with
// its package hash); Social's own approval fields stay empty or name the
// hand-off ("worker"), which is not a missing approval. So for such posts
// the native approval is not shown; only native decisions are interpreted.

export type OriginKind = "marketing" | "draft_handoff" | "postiz" | null;

/** What kind of origin a post has, from its originRef (or its origin for older answers). */
export function originKind(post: {
  origin: string;
  originRef?: OriginRef;
}): OriginKind {
  const ref = post.originRef;
  if (ref?.module === "marketing")
    return ref.type === "draft_handoff" ? "draft_handoff" : "marketing";
  if (ref?.module === "postiz" || post.origin === "legacy_postiz")
    return "postiz";
  return null;
}

/**
 * The words a post's origin and approval show: the origin line, the native
 * approval only where Social decided it (a hand-off draft, or a post
 * written here), and Marketing's publication id for the reference link.
 */
export function originView(
  post: { origin: string; originRef?: OriginRef; approvalState: ApprovalState },
  locale: "en" | "de",
): {
  origin: string | null;
  approval: string | null;
  publicationId: string | null;
} {
  const t = socialText(locale).posts;
  const kind = originKind(post);
  const native = t.approval[post.approvalState] || null;
  if (kind === "marketing")
    return {
      origin: t.origin.marketing,
      approval: null,
      publicationId:
        post.originRef?.type === "publication" ? post.originRef.id : null,
    };
  if (kind === "postiz")
    return { origin: t.origin.postiz, approval: null, publicationId: null };
  if (kind === "draft_handoff")
    return {
      origin: t.origin.draftHandoff,
      approval: native,
      publicationId: null,
    };
  return { origin: null, approval: native, publicationId: null };
}

/**
 * The link to Marketing's approvals for the publication behind a post, by
 * route key (no import of that module), while Marketing is open to the
 * member; null otherwise.
 */
export function useMarketingApprovalsHref(publicationId: string | null) {
  const shell = useContext(ShellContext);
  if (!publicationId || !shell) return null;
  const open = shell.modules.some(
    (m) => m.id === "marketing" && m.enabled && m.access !== "none",
  );
  return open
    ? `${shell.hrefOf("approvals")}?publication=${encodeURIComponent(publicationId)}`
    : null;
}

/** The origin line with its reference link, and the native approval where it applies. */
export function OriginNote({
  post,
  locale,
}: {
  post: { origin: string; originRef?: OriginRef; approvalState: ApprovalState };
  locale: "en" | "de";
}) {
  const view = originView(post, locale);
  const href = useMarketingApprovalsHref(view.publicationId);
  if (!view.origin && !view.approval) return null;
  return (
    <span className="field-hint social-origin">
      {view.origin}
      {view.origin && view.approval ? " · " : ""}
      {view.approval}
      {href && (
        <>
          {" · "}
          <AppLink className="text-link" href={href}>
            {socialText(locale).posts.origin.openMarketing}
          </AppLink>
        </>
      )}
    </span>
  );
}
