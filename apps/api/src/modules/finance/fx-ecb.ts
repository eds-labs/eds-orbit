import { DomainError } from "../../shared.ts";
import { isCurrency } from "./money.ts";

const DECIMAL = /^\d+(?:\.\d{1,12})?$/;
const DAY_CUBE = /<Cube\s+time\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>([\s\S]*?)<\/Cube\s*>/g;
const RATE_CUBE = /<Cube\s+([^>]*?)\/?>/g;
const attribute = (attributes: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    attributes,
  );
  return match ? (match[1] ?? match[2]) : undefined;
};

/**
 * Parses the ECB reference-rate feed (`<Cube time=…><Cube currency=… rate=…/>`,
 * either quote style). Only currencies Orbit knows are kept; EUR is implicit.
 * Rates are units of the currency per 1 EUR, kept as the feed's decimal text.
 * A document without a single day throws `FX_FEED_INVALID`.
 */
export function parseEcbXml(
  xml: string,
): { date: string; perEur: Record<string, string> }[] {
  const days: { date: string; perEur: Record<string, string> }[] = [];
  for (const day of xml.matchAll(DAY_CUBE)) {
    const date = day[1] ?? day[2] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const perEur: Record<string, string> = {};
    for (const cube of day[3]!.matchAll(RATE_CUBE)) {
      const currency = attribute(cube[1]!, "currency");
      const rate = attribute(cube[1]!, "rate");
      if (!currency || !rate || currency === "EUR" || !isCurrency(currency))
        continue;
      if (!DECIMAL.test(rate) || /^0+(?:\.0+)?$/.test(rate)) continue;
      perEur[currency] = rate;
    }
    days.push({ date, perEur });
  }
  if (!days.length) throw new DomainError("FX_FEED_INVALID", 422);
  return days;
}
