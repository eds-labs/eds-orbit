import { z } from "zod";

export const WEBMAIL_INBOX_PREVIEW_LIMIT = 5;

export const webmailInboxSummary = z.object({
  unread: z.int().nonnegative(),
  messages: z
    .array(
      z.object({
        uid: z.int().positive(),
        sender: z.string().max(160).nullable(),
        subject: z.string().max(240).nullable(),
        receivedAt: z.iso.datetime().nullable(),
        unread: z.boolean(),
      }),
    )
    .max(WEBMAIL_INBOX_PREVIEW_LIMIT),
});

export type WebmailInboxSummary = z.infer<typeof webmailInboxSummary>;

export const webmailUnreadSummary = z.object({
  total: z.int().nonnegative(),
  complete: z.boolean(),
  counts: z.record(z.string(), z.int().nonnegative().nullable()),
});

export type WebmailUnreadSummary = z.infer<typeof webmailUnreadSummary>;
