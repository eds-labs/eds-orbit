import { z } from "zod";

/** Ticket priorities; support_insights keeps a copy (tested in sync). */
export const SUPPORT_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const PRIORITIES = SUPPORT_PRIORITIES;

const slaTarget = z
  .object({
    firstResponseMinutes: z.number().int().min(1).max(43_200),
    resolutionMinutes: z.number().int().min(1).max(129_600),
  })
  .strict();

/**
 * The support module's project settings, stored in ProjectModule.settings
 * (06 §3.1). Retention defaults are Mario's decision Q-12b (2026-10-17);
 * owners may shorten them, closed tickets up to 72 months.
 */
/** The colours a ticket tag can have; the web maps each to a token. */
export const TAG_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "orange",
  "red",
  "purple",
  "pink",
] as const;

export const supportSettingsSchema = z
  .object({
    categories: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
            label: z.string().min(1).max(60),
          })
          .strict(),
      )
      .max(50)
      .refine(
        (items) => new Set(items.map((c) => c.key)).size === items.length,
        "Category keys must be unique",
      ),
    // Ticket tags, like Chatwoot labels: several per ticket, from this list.
    tags: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
            label: z.string().trim().min(1).max(40),
            color: z.enum(TAG_COLORS),
          })
          .strict(),
      )
      .max(50)
      .refine(
        (items) => new Set(items.map((t) => t.key)).size === items.length,
        "Tag keys must be unique",
      ),
    sla: z
      .object(
        Object.fromEntries(PRIORITIES.map((p) => [p, slaTarget])) as Record<
          (typeof PRIORITIES)[number],
          typeof slaTarget
        >,
      )
      .strict(),
    autoAck: z.boolean(),
    // Support AI per day, in micros, on top of the project's spend mandate.
    aiDailyBudgetMicros: z.number().int().min(0).max(100_000_000),
    autoCloseDays: z.number().int().min(1).max(90),
    reopenOnReply: z.boolean(),
    retention: z
      .object({
        closedTicketMonths: z.number().int().min(1).max(72),
        rawEmailDays: z.number().int().min(1).max(365),
        aiDraftDays: z.number().int().min(1).max(365),
        widgetSessionDays: z.number().int().min(1).max(365),
      })
      .strict(),
  })
  .strict();

export type SupportSettings = z.infer<typeof supportSettingsSchema>;
export type SupportPriority = (typeof PRIORITIES)[number];

// First-response targets in minutes on a 24/7 clock; resolution is 3x.
const FIRST_RESPONSE: Record<SupportPriority, number> = {
  urgent: 240,
  high: 480,
  normal: 1440,
  low: 4320,
};

export function supportSettingsDefaults(): SupportSettings {
  return {
    categories: [],
    tags: [],
    sla: Object.fromEntries(
      PRIORITIES.map((p) => [
        p,
        {
          firstResponseMinutes: FIRST_RESPONSE[p],
          resolutionMinutes: FIRST_RESPONSE[p] * 3,
        },
      ]),
    ) as SupportSettings["sla"],
    autoAck: true,
    aiDailyBudgetMicros: 2_000_000,
    autoCloseDays: 7,
    reopenOnReply: true,
    retention: {
      closedTicketMonths: 24,
      rawEmailDays: 90,
      aiDraftDays: 90,
      widgetSessionDays: 30,
    },
  };
}

/**
 * Per-inbox switches over the project's settings (WP5.5); a missing key
 * keeps the project default.
 */
export const inboxRulesSchema = z
  .object({
    autoAck: z.boolean(),
    autoClose: z.boolean(),
    autoCloseDays: z.number().int().min(1).max(90),
    reopenOnReply: z.boolean(),
    sla: z.boolean(),
  })
  .partial()
  .strict();
export type InboxRules = z.infer<typeof inboxRulesSchema>;

/** The rules that apply to an inbox: its switches over the project settings. */
export function effectiveRules(settings: SupportSettings, raw: unknown) {
  const rules = inboxRulesSchema.safeParse(raw ?? {});
  const own = rules.success ? rules.data : {};
  return {
    autoAck: own.autoAck ?? settings.autoAck,
    autoClose: own.autoClose ?? true,
    autoCloseDays: own.autoCloseDays ?? settings.autoCloseDays,
    reopenOnReply: own.reopenOnReply ?? settings.reopenOnReply,
    sla: own.sla ?? true,
  };
}
