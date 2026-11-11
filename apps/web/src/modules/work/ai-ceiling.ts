"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import type { AiCeiling } from "@/platform/shell/types";
import { workPath } from "./api";

// The AI project manager's ceilings, from the request its settings section
// makes (/pm/settings). Both ceilings read the same resource shape.
function usePmCeilings() {
  const { project } = useWorkspace();
  const current = useResource<{
    settings: { dailyCeilingMicros: number; codingMonthlyCeilingMicros: number };
  }>(workPath(project.id, "/pm/settings"));
  return current.error ? null : (current.data?.settings ?? null);
}

export const workAiCeilings: readonly AiCeiling[] = [
  {
    key: "pm",
    label: { en: "AI project manager", de: "KI-Projektleiter" },
    section: "work/settings",
    useCeiling() {
      const settings = usePmCeilings();
      return settings
        ? { micros: settings.dailyCeilingMicros, period: "day" }
        : null;
    },
  },
  {
    key: "coding",
    label: { en: "Coding runs", de: "Coding-Läufe" },
    section: "work/settings",
    useCeiling() {
      const settings = usePmCeilings();
      return settings
        ? { micros: settings.codingMonthlyCeilingMicros, period: "month" }
        : null;
    },
  },
];
