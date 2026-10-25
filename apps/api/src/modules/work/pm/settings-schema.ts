import { z } from "zod";

// Settings of the AI project manager (ADR 0017, plan §3). The project part
// lives in the work module's settings under `pm` and only an owner with
// `work.pm.manage` changes it; the initiative part lives in WorkPmState.

const repoKey = z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/);
/** A GitHub repository, `owner/name`. */
export const repositoryFullName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);

export const pmRepositorySchema = z
  .object({
    key: repoKey,
    label: z.string().trim().min(1).max(80),
    provider: z.literal("github"),
    fullName: repositoryFullName,
    defaultBranch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/),
    dispatch: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("manual") }).strict(),
      z.object({ kind: z.literal("automation"), bindingId: z.uuid() }).strict(),
    ]),
  })
  .strict();
export type PmRepository = z.infer<typeof pmRepositorySchema>;

export const PM_AUTONOMY = ["propose", "comment_only"] as const;

export const pmSettingsSchema = z
  .object({
    /** `propose` (Q-P2-3): every change is a proposal. */
    autonomy: z.enum(PM_AUTONOMY),
    /** The PM's AI spend per project and UTC day (Q-P2-1: USD 2). */
    dailyCeilingMicros: z.int().min(0).max(100_000_000),
    /** Reported plus reserved coding spend per calendar month; 0 blocks paid dispatch. */
    codingMonthlyCeilingMicros: z.int().min(0).max(1_000_000_000),
    codingMaxConcurrent: z.int().min(1).max(10),
    codingTimeoutHours: z.int().min(1).max(168),
    repositories: z
      .array(pmRepositorySchema)
      .max(20)
      .refine(
        (items) => new Set(items.map((r) => r.key)).size === items.length,
        "repository keys must be unique",
      ),
  })
  .strict();
export type PmSettings = z.infer<typeof pmSettingsSchema>;

export const defaultPmSettings = (): PmSettings => ({
  autonomy: "propose",
  dailyCeilingMicros: 2_000_000,
  codingMonthlyCeilingMicros: 0,
  codingMaxConcurrent: 3,
  codingTimeoutHours: 24,
  repositories: [],
});

export const REPORT_SCHEDULES = ["off", "weekly", "daily"] as const;
export const RESEARCH_MODES = ["off", "knowledge", "web"] as const;

/** The PM settings of one initiative (WorkPmState.settings). */
export const pmInitiativeSettingsSchema = z
  .object({
    /** Q-P2-2: weekly reports on Monday 08:00, off until enabled. */
    reportSchedule: z.enum(REPORT_SCHEDULES),
    /** Q-P2-5: web research off by default. */
    research: z.enum(RESEARCH_MODES),
    /** Who besides the initiative's owner hears critical findings. */
    escalateTo: z.array(z.string().min(1).max(100)).max(10),
  })
  .strict();
export type PmInitiativeSettings = z.infer<typeof pmInitiativeSettingsSchema>;

export const defaultPmInitiativeSettings = (): PmInitiativeSettings => ({
  reportSchedule: "off",
  research: "knowledge",
  escalateTo: [],
});
