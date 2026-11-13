"use client";
import { PublicKeysPanel, publicKeyText } from "@/components/public-keys";
import { useWorkspace } from "@/components/workspace-context";
import type { SectionProps } from "../types";

/**
 * The project's public keys. Everyone with the integrations capability sees
 * the section, but only owners may list keys, so the panel (which requests
 * the list on mount) is rendered for owners alone.
 */
export function PublicAccessSection({ locale }: SectionProps) {
  const { isOwner } = useWorkspace();
  if (!isOwner)
    return <p className="panel-note">{publicKeyText(locale, "ownerOnly")}</p>;
  return <PublicKeysPanel />;
}
