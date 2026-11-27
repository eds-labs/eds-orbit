"use client";
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import Link from "next/link";
import { LogOut, Settings } from "lucide-react";
import type { Identity } from "@/lib/api";
import type { Text } from "@/lib/i18n";
import { AppearanceOptions } from "@/platform/appearance/appearance-options";

/**
 * The account menu opens the center (ADR 0013,
 * settings center phase 5), which holds the account, the organization settings
 * and the administration. It also holds this browser's appearance setting.
 * What a member sees in the center follows their capabilities.
 */
const MANAGE_HREF = "/manage";

function moveMenuFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
  const { key } = event;
  if (
    key !== "ArrowDown" &&
    key !== "ArrowUp" &&
    key !== "Home" &&
    key !== "End"
  )
    return;
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled), [role="menuitemradio"]',
    ),
  );
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  event.preventDefault();
  if (key === "Home") items[0]?.focus();
  else if (key === "End") items.at(-1)?.focus();
  else {
    const offset = key === "ArrowDown" ? 1 : -1;
    items[(current + offset + items.length) % items.length]?.focus();
  }
}

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
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !menu.contains(e.target as Node)
      ) {
        menu.open = false;
        if (e instanceof KeyboardEvent) menu.querySelector("summary")?.focus();
      }
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
      <div
        className="user-menu-panel"
        role="menu"
        onKeyDown={moveMenuFocus}
      >
        <div className="user-menu-who">
          <strong>{name}</strong>
          <small>{identity.user.email}</small>
        </div>
        <Link role="menuitem" href={MANAGE_HREF} className="user-menu-item">
          <Settings aria-hidden />
          {t("manageTitle")}
        </Link>
        <AppearanceOptions t={t} />
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
