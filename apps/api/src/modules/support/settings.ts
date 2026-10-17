import { z } from "zod";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

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
    sla: z
      .object(
        Object.fromEntries(PRIORITIES.map((p) => [p, slaTarget])) as Record<
          (typeof PRIORITIES)[number],
          typeof slaTarget
        >,
      )
      .strict(),
    autoAck: z.boolean(),
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
