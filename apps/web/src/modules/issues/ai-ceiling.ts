"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import type { AiCeiling } from "@/platform/shell/types";
import { issuesPath, type IssuesSettings } from "./api";

// The triage ceiling, from the request the issues settings section makes.
export const issuesAiCeilings: readonly AiCeiling[] = [
  {
    key: "triage",
    label: { en: "AI triage", de: "KI-Einordnung" },
    section: "issues/settings",
    useCeiling() {
      const { project } = useWorkspace();
      const current = useResource<{ settings: IssuesSettings }>(
        issuesPath(project.id, "/settings"),
      );
      const triage = current.error ? null : current.data?.settings.triage;
      return triage
        ? {
            micros: triage.aiDailyCeilingMicros,
            period: "day",
            on: triage.aiEnabled,
          }
        : null;
    },
  },
];
