"use client";
import { createContext, useContext } from "react";
import type { Identity } from "@/lib/api";
import type { Locale, Text } from "@/lib/i18n";

/**
 * What a standalone page (outside any project, such as /connect) gets from
 * the shell: the language and, once signed in, who the user is.
 */
export type StandaloneContextValue = {
  locale: Locale;
  t: Text;
  /** Null on pages that need no session. */
  identity: Identity | null;
  /** Changes the interface language (the account page's preference). */
  setLocale?: (locale: Locale) => void;
  /** Reloads who is signed in, after a sign-in or a profile change. */
  refreshIdentity?: () => void;
};

export const StandaloneContext = createContext<StandaloneContextValue | null>(
  null,
);

export function useStandalone() {
  const value = useContext(StandaloneContext);
  if (!value) throw new Error("Standalone page context required");
  return value;
}
