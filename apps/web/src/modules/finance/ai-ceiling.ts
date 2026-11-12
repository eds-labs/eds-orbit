"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import type { AiCeiling } from "@/platform/shell/types";
import { financePath, type SettingsResponse } from "./api";

// The daily extraction ceiling, from the request the AI extraction section
// of the settings makes, so the settings center and the section share it.
export const financeAiCeilings: readonly AiCeiling[] = [
  {
    key: "extraction",
    label: { en: "Document extraction", de: "Belege auslesen" },
    section: "finance/ai",
    useCeiling() {
      const { project } = useWorkspace();
      const current = useResource<SettingsResponse>(
        financePath(project.id, "/settings"),
      );
      const settings = current.error ? null : current.data?.settings;
      return settings
        ? {
            micros: settings.aiDailyCeilingMicros,
            period: "day",
            on: settings.aiExtraction === "on",
          }
        : null;
    },
  },
];
