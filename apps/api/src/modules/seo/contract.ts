import { z } from "zod";
import { seoDimensions } from "./provider/types.ts";

export const seoProviderId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export const seoDimension = z.enum(seoDimensions);
export const SEO_MAX_REPORT_DAYS = 90;
export const SEO_MAX_REPORT_ROWS = 100;

export const searchPerformanceQuery = z
  .object({
    provider: seoProviderId,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    dimension: seoDimension.default("date"),
    limit: z.int().min(1).max(SEO_MAX_REPORT_ROWS).default(SEO_MAX_REPORT_ROWS),
  })
  .strict()
  .refine(({ startDate, endDate }) => {
    const span = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000;
    return span >= 0 && span < SEO_MAX_REPORT_DAYS;
  }, "SEO_DATE_RANGE_INVALID");

export const createWebsiteInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .transform((input, ctx) => {
        const url = URL.parse(input);
        if (
          !url ||
          !/^https?:\/\//i.test(input) ||
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.href.length > 2048
        ) {
          ctx.issues.push({
            code: "custom",
            input,
            message: "SEO_WEBSITE_URL_INVALID",
          });
          return z.NEVER;
        }
        return url.href;
      }),
  })
  .strict();

export const bindPropertyInput = z
  .object({
    connectionId: z.uuid(),
    propertyId: z.string().min(1).max(2048),
  })
  .strict();
