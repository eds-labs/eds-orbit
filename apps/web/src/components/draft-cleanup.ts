import type { Entity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";

/** Content statuses the approvals page lists; archived drafts are not among them. */
export const APPROVAL_STATUSES = [
  "review",
  "needs_review",
  "reviewed",
  "draft",
  "blocked",
  "pending_approval",
];

export function approvalItems(content: Entity[]) {
  return content.filter((c) =>
    APPROVAL_STATUSES.includes(String(c.data.status)),
  );
}

/** The counts `archive-old-drafts` answers with, for a preview and a run. */
export type DraftCleanupSummary = {
  preview: boolean;
  cleanupId?: string | null;
  content: { total: number };
  missions: { total: number };
  kept: { total: number };
};

export function cleanupConfirmText(s: DraftCleanupSummary, locale: Locale) {
  return locale === "de"
    ? `${s.content.total} Entwürfe und ${s.missions.total} Missionen werden archiviert (wiederherstellbar). Behalten werden ${s.kept.total} mit offener Veröffentlichung.`
    : `${s.content.total} drafts and ${s.missions.total} missions will be archived (restorable). ${s.kept.total} with an open publication are kept.`;
}

export function cleanupDoneText(s: DraftCleanupSummary, locale: Locale) {
  return locale === "de"
    ? `${s.content.total} Entwürfe und ${s.missions.total} Missionen archiviert.`
    : `${s.content.total} drafts and ${s.missions.total} missions archived.`;
}
