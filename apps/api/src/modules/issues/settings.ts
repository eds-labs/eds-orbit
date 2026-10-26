import { z } from "zod";
import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  readModuleSettings,
  writeModuleSettings,
} from "../../platform/modules/settings.ts";

// The issue center's project settings (ADR 0018, plan §3). The platform
// stores and versions them in the module's ProjectModule row.

const key = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
const label = z
  .object({
    en: z.string().trim().min(1).max(60),
    de: z.string().trim().min(1).max(60),
  })
  .strict();
const unique = <T extends { key: string }>(items: T[]) =>
  new Set(items.map((i) => i.key)).size === items.length;
const micros = z.int().min(0).max(100_000_000);

export const issuesSettingsSchema = z
  .object({
    /** The product's components; issues name them by key. */
    components: z
      .array(
        z
          .object({
            key,
            label,
            /** A repository key of the work module's settings, if any. */
            repository: key.optional(),
            team: z.string().trim().min(1).max(60).optional(),
          })
          .strict(),
      )
      .max(100)
      .refine(unique, "component keys must be unique"),
    categories: z
      .array(z.object({ key, label }).strict())
      .max(50)
      .refine(unique, "category keys must be unique"),
    dedupe: z
      .object({
        /** A report with an open issue's fingerprint joins it (stage 1). */
        autoAttachFingerprint: z.boolean(),
        /** The lexical score above which a candidate is shown (stage 3). */
        suggestThreshold: z.number().min(0).max(1),
        // Stages 4 and 5 are opt-in and not part of the MVP.
        vectorEnabled: z.literal(false),
        aiJudgeEnabled: z.literal(false),
        aiDailyCeilingMicros: micros,
      })
      .strict(),
    triage: z
      .object({
        /** AI suggestions for new issues (issue_triage); off by default. */
        aiEnabled: z.boolean(),
        aiDailyCeilingMicros: micros,
      })
      .strict(),
    sync: z
      .object({
        /** All implementing tasks done → fix ready (S2, Q-P3-6). */
        autoFixReady: z.boolean(),
        /** An exact production deployment signal → released (S4). */
        autoRelease: z.boolean(),
      })
      .strict(),
    intake: z
      .object({ dailyReportCap: z.int().min(1).max(10_000) })
      .strict(),
    retention: z
      .object({
        closedIssueMonths: z.int().min(1).max(120),
        diagnosticsMonths: z.int().min(1).max(120),
      })
      .strict(),
    /** Environment names that count as production for releases. */
    productionEnvironments: z
      .array(z.string().trim().min(1).max(40))
      .min(1)
      .max(10),
  })
  .strict()
  .refine(
    (s) => s.retention.diagnosticsMonths <= s.retention.closedIssueMonths,
    "diagnostics cannot outlive their issue",
  );
export type IssuesSettings = z.infer<typeof issuesSettingsSchema>;

/** Mario's defaults of 2026-10-25 (Q-P3-5, Q-P3-6). */
export const defaultIssuesSettings = (): IssuesSettings => ({
  components: [],
  categories: [],
  dedupe: {
    autoAttachFingerprint: true,
    suggestThreshold: 0.35,
    vectorEnabled: false,
    aiJudgeEnabled: false,
    aiDailyCeilingMicros: 0,
  },
  triage: { aiEnabled: false, aiDailyCeilingMicros: 500_000 },
  sync: { autoFixReady: true, autoRelease: false },
  intake: { dailyReportCap: 500 },
  retention: { closedIssueMonths: 36, diagnosticsMonths: 12 },
  productionEnvironments: ["production"],
});

export function readIssuesSettings(tx: DbTx, scope: Scope) {
  return readModuleSettings(tx, scope, "issues", issuesSettingsSchema, defaultIssuesSettings);
}

/** Saves the settings when `version` is the stored one. */
export function saveIssuesSettings(tx: DbTx, scope: Scope, raw: unknown, version: number) {
  return writeModuleSettings(tx, scope, "issues", issuesSettingsSchema, raw, version);
}
