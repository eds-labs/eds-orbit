"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { Building2, LogOut, ShieldCheck, UserRound } from "lucide-react";
import type { Identity } from "@/lib/api";
import type { Text } from "@/lib/i18n";

/**
 * The entries of the account menu (ADR 0012): the account for everyone,
 * organization settings for organization owners and the administration for
 * system administrators. Hiding an entry is convenience; the API refuses
 * the pages to anyone else.
 */
export function userMenuEntries(
  identity: Identity,
  organizationId: string | undefined,
) {
  const organization = identity.workspaces.find((w) =>
    organizationId ? w.id === organizationId : w.canManage,
  );
  return {
    account: Boolean(identity.account),
    organization: organization?.canManage
      ? `/o/${encodeURIComponent(organization.id)}/settings`
      : null,
    admin: Boolean(identity.systemAdmin),
  };
}

export function UserMenu({
  identity,
  organizationId,
  role,
  t,
  onSignOut,
  signingOut,
}: {
  identity: Identity;
  /** The open project's organization, if any. */
  organizationId?: string;
  role?: string;
  t: Text;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const entries = userMenuEntries(identity, organizationId);
  // Closes on a click outside or Escape.
  useEffect(() => {
    const close = (e: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menu.contains(e.target as Node))
        menu.open = false;
    };
    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const name = identity.user.name;
  return (
    <details className="user-menu" ref={ref}>
      <summary
        className="avatar"
        aria-label={`${t("accountMenu")}: ${name}`}
        title={role ? `${name} · ${role}` : name}
      >
        {name.charAt(0).toUpperCase()}
      </summary>
      <div className="user-menu-panel" role="menu">
        <div className="user-menu-who">
          <strong>{name}</strong>
          <small>{identity.user.email}</small>
        </div>
        {entries.account && (
          <Link role="menuitem" href="/account" className="user-menu-item">
            <UserRound aria-hidden />
            {t("accountTitle")}
          </Link>
        )}
        {entries.organization && (
          <Link role="menuitem" href={entries.organization} className="user-menu-item">
            <Building2 aria-hidden />
            {t("organizationSettings")}
          </Link>
        )}
        {entries.admin && (
          <Link role="menuitem" href="/admin" className="user-menu-item">
            <ShieldCheck aria-hidden />
            {t("administration")}
          </Link>
        )}
        <button
          role="menuitem"
          className="user-menu-item"
          disabled={signingOut}
          onClick={onSignOut}
        >
          <LogOut aria-hidden />
          {t("signOut")}
        </button>
      </div>
    </details>
  );
}
