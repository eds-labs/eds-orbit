"use client";
import { useResource } from "@/lib/api";
import { useWorkspace } from "@/components/workspace-context";
import type { AiCeiling } from "@/platform/shell/types";
import { supportPath } from "./api";

// The daily support AI budget, from the request the support settings make.
export const supportAiCeilings: readonly AiCeiling[] = [
  {
    key: "ai",
    label: { en: "Support AI", de: "Support-KI" },
    section: "support/settings",
    useCeiling() {
      const { project } = useWorkspace();
      const current = useResource<{
        settings: { aiDailyBudgetMicros: number };
      }>(supportPath(project.id, "/settings"));
      const settings = current.error ? null : current.data?.settings;
      return settings
        ? { micros: settings.aiDailyBudgetMicros, period: "day" }
        : null;
    },
  },
];
