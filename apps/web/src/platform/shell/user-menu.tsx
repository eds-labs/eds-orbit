"use client";
import { useEffect, useRef } from "react";
import Link from "next/link";
import { LogOut, Settings } from "lucide-react";
import type { Identity } from "@/lib/api";
import type { Text } from "@/lib/i18n";

/**
 * The account menu has one entry besides signing out: the center (ADR 0013,
 * settings center phase 5), which holds the account, the organization settings
 * and the administration. What a member sees there follows their
 * capabilities; the API refuses the pages to anyone else.
 */
const MANAGE_HREF = "/manage";

export function UserMenu({
  identity,
  role,
  t,
  onSignOut,
  signingOut,
}: {
  identity: Identity;
  role?: string;
  t: Text;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
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
        <Link role="menuitem" href={MANAGE_HREF} className="user-menu-item">
          <Settings aria-hidden />
          {t("manageTitle")}
        </Link>
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
