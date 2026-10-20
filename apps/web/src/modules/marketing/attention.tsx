import type { AttentionRenderer, Label } from "@/platform/shell/types";

// The marketing module's attention texts (UI restructure §4.3). Params carry
// names, codes and times only, never a post body; the home page shows the
// due time (a draft's slot) from `dueAt`.

const REVIEW: Label = { en: "Review", de: "Prüfen" };
const SHOW: Label = { en: "Show", de: "Anzeigen" };

/** English and German text by count. */
type Counted = (n: number) => Label;

const runProblems: Record<string, Counted> = {
  RUN_DEGRADED: (n) => ({
    en: `${n} marketing run(s) have missing optional inputs or deliverables`,
    de: `${n} Marketing-Läufe mit fehlenden optionalen Eingaben oder Ergebnissen`,
  }),
  RUN_OUTCOME_UNKNOWN: (n) => ({
    en: `${n} marketing run outcome(s) need reconciliation`,
    de: `${n} Marketing-Laufergebnisse müssen abgeglichen werden`,
  }),
  RUN_FAILED: (n) => ({
    en: `${n} agent run${n === 1 ? "" : "s"} failed`,
    de: `${n} ${n === 1 ? "Agentenlauf" : "Agentenläufe"} fehlgeschlagen`,
  }),
  BUDGET_EXHAUSTED: (n) => ({
    en: `${n} assignment${n === 1 ? "" : "s"} out of budget`,
    de: `${n} ${n === 1 ? "Auftrag" : "Aufträge"} ohne Monatsbudget`,
  }),
};

const counted =
  (text: Counted, action: Label): AttentionRenderer =>
  (item, locale) => ({ title: text(item.count ?? 1)[locale], action });

export const marketingAttention: Readonly<Record<string, AttentionRenderer>> = {
  marketing_draft_release: (item, locale) => ({
    title: `${locale === "de" ? "Entwurf freigeben" : "Release draft"} · ${String(item.params.assignmentName || "—")}`,
    detail: String(item.params.channelName ?? "") || undefined,
    action: REVIEW,
  }),
  marketing_content_review: counted(
    (n) => ({
      en: `${n} content item${n === 1 ? "" : "s"} to review`,
      de: `${n} ${n === 1 ? "Inhalt wartet" : "Inhalte warten"} auf Freigabe`,
    }),
    REVIEW,
  ),
  marketing_exception: (item, locale) => {
    const code = String(item.params.code ?? "");
    const de = locale === "de";
    // One item per code (R19); the resources it affects are a param.
    const affected = Number(item.params.affected ?? 0);
    return {
      title: `${
        code.endsWith("_OUTCOME_UNKNOWN")
          ? de
            ? "Ergebnis unklar"
            : "Outcome unclear"
          : de
            ? "Offene Ausnahme"
            : "Open exception"
      } · ${code || "—"}`,
      detail:
        affected > 0
          ? de
            ? `betrifft ${affected}`
            : `affects ${affected}`
          : undefined,
      action: { en: "Check", de: "Prüfen" },
    };
  },
  marketing_paused_posts: counted(
    (n) => ({
      en: `${n} post${n === 1 ? "" : "s"} held by the pause`,
      de: `${n} ${n === 1 ? "Post" : "Posts"} wegen Pause angehalten`,
    }),
    SHOW,
  ),
  marketing_run_problem: (item, locale) => {
    const code = String(item.params.code ?? "");
    const text = runProblems[code];
    return {
      title: text
        ? text(item.count ?? 1)[locale]
        : `${locale === "de" ? "Problem mit Agentenläufen" : "Agent run problem"} · ${code || "—"}`,
      action: SHOW,
    };
  },
};
