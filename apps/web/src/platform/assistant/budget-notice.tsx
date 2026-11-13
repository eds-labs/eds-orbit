"use client";
import { manageHref } from "@/platform/settings-center/routes";
import Link from "next/link";
import { RefreshCw, Settings } from "lucide-react";
import { Alert, Button } from "@/components/ui/primitives";
import type { Identity } from "@/lib/api";
import type { AssistantStatus } from "./api";
import type { AssistantContextValue } from "./assistant-context";

// The personal assistant's budget notice (ADR 0022 D-09, plan 2026-11-10
// WP2 A). The assistant is paid only from the organization's per-member
// cap, never from a project budget. Without a cap the server refuses every
// paid turn (POLICY_REQUIRED), with a cap of 0 too (BUDGET_NOT_APPROVED),
// so the panel says so before sending and keeps the composer blocked. Role
// and flags come from the identity the shell already has; nothing is
// fetched and nothing is ever set automatically.

/** The anchor of the assistant cap on the organization settings page. */
export const ASSISTANT_BUDGET_ANCHOR = "assistant-budget";

export type AssistantBudgetState =
  | { blocked: false }
  | {
      blocked: true;
      /** No cap saved (null) or a cap of 0. */
      reason: "not_set" | "zero";
      /**
       * owner: may set it on the organization settings page (`href`);
       * owner_unavailable: an owner, but the page or panel is off on this
       * installation; member: only an organization owner can set it.
       */
      audience: "owner" | "owner_unavailable" | "member";
      href?: string;
    };

type IdentityFlags = Pick<
  Identity,
  "workspaces" | "administration" | "connections"
>;

/** Whether the member's assistant can make paid turns now, and who can change it. */
export function assistantBudgetState(
  status: AssistantStatus | null | undefined,
  identity: IdentityFlags | null | undefined,
): AssistantBudgetState {
  if (!status?.enabled) return { blocked: false };
  const cap = status.capMicros;
  if (cap !== null && cap > 0) return { blocked: false };
  const reason = cap === null ? "not_set" : "zero";
  const workspace = identity?.workspaces.find(
    (w) => w.id === status.workspaceId,
  );
  if (workspace?.role !== "owner")
    return { blocked: true, reason, audience: "member" };
  // The organization settings need ORBIT_ADMINISTRATION (canManage) and the
  // budget panel ORBIT_CONNECTIONS; the API refuses the cap otherwise.
  const settings =
    (workspace.canManage ?? identity?.administration === true) &&
    identity?.connections === true;
  if (!settings) return { blocked: true, reason, audience: "owner_unavailable" };
  return {
    blocked: true,
    reason,
    audience: "owner",
    href: `${manageHref(
      { kind: "organization", organizationId: status.workspaceId },
      "ai",
      "budget",
    )}#${ASSISTANT_BUDGET_ANCHOR}`,
  };
}

export const budgetNoticeText = (de: boolean) => ({
  not_set: de
    ? "Persönliches Assistentenbudget der Organisation nicht gesetzt"
    : "The organization's personal assistant budget is not set",
  zero: de
    ? "Das Assistentenbudget pro Mitglied steht auf 0 USD"
    : "The assistant budget per member is set to USD 0",
  why: de
    ? "Der persönliche Assistent wird nur aus diesem Budget der Organisation bezahlt, nicht aus Projektbudgets. Solange es fehlt, macht er keine bezahlten Aufrufe."
    : "The personal assistant is paid only from this organization budget, not from project budgets. Until it is set, it makes no paid calls.",
  owner: de
    ? "Als Owner der Organisation legst du die monatliche Obergrenze pro Mitglied in den Organisationseinstellungen fest."
    : "As an owner of the organization, you set the monthly cap per member in the organization settings.",
  ownerLink: de ? "Assistentenbudget festlegen" : "Set the assistant budget",
  ownerUnavailable: de
    ? "Diese Einstellung ist auf dieser Installation nicht verfügbar (Administration oder zentrale Verbindungen sind ausgeschaltet)."
    : "This setting is not available on this installation (administration or central connections are switched off).",
  member: de
    ? "Nur Owner der Organisation legen dieses Budget fest; Projektbudgets gelten hier nicht. Bitte einen Owner deiner Organisation, es festzulegen."
    : "Only owners of the organization set this budget; project budgets do not apply here. Ask an owner of your organization to set it.",
  refresh: de ? "Erneut prüfen" : "Check again",
});

/**
 * The ConversationView props of the panel and the full page: the notice
 * and the blocked composer while the assistant cannot make paid turns.
 */
export function assistantBudgetProps(
  assistant: Pick<
    AssistantContextValue,
    "status" | "identity" | "locale" | "refreshStatus"
  >,
  onNavigate?: () => void,
) {
  const state = assistantBudgetState(assistant.status, assistant.identity);
  if (!state.blocked) return { blocked: false };
  return {
    blocked: true,
    notice: (
      <AssistantBudgetNotice
        state={state}
        de={assistant.locale === "de"}
        onNavigate={onNavigate}
        onRefresh={assistant.refreshStatus}
      />
    ),
  };
}

/** The notice above the composer while the assistant cannot make paid turns. */
export function AssistantBudgetNotice({
  state,
  de,
  onNavigate,
  onRefresh,
}: {
  state: AssistantBudgetState;
  de: boolean;
  /** Called when the owner follows the link (the panel closes itself). */
  onNavigate?: () => void;
  /** Reads the assistant's status again, e.g. after an owner set the cap. */
  onRefresh?: () => void;
}) {
  if (!state.blocked) return null;
  const t = budgetNoticeText(de);
  return (
    <Alert kind="warning">
      <strong>{state.reason === "zero" ? t.zero : t.not_set}</strong>
      <p>{t.why}</p>
      <p>
        {state.audience === "owner"
          ? t.owner
          : state.audience === "owner_unavailable"
            ? t.ownerUnavailable
            : t.member}
      </p>
      <div className="form-actions">
        {state.audience === "owner" && state.href && (
          <Link
            className="button button-outline button-sm"
            href={state.href}
            onClick={onNavigate}
          >
            <Settings aria-hidden="true" />
            {t.ownerLink}
          </Link>
        )}
        {onRefresh && (
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            <RefreshCw aria-hidden="true" />
            {t.refresh}
          </Button>
        )}
      </div>
    </Alert>
  );
}
