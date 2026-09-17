"use client";
import { createContext, useContext } from "react";
import type { Project, Identity } from "@/lib/api";
import type { Locale, Text } from "@/lib/i18n";
export type WorkspaceContextValue = {
  project: Project;
  identity: Identity;
  locale: Locale;
  t: Text;
  canEdit: boolean;
  isOwner: boolean;
  revision: number;
  refresh: () => void;
};
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(
  null,
);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace required");
  return value;
}
