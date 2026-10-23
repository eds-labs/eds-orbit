// JSON views of finance results. Amounts are bigint micros in the database
// and the services; JSON has no bigint, so every bigint leaves the API as a
// decimal string ("12345678") next to the currency it is in. Only finance
// responses go through this; the server's global serialization is unchanged.

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A deep copy of `value` that JSON can carry: bigint as a decimal string,
 * Date as an ISO timestamp, objects with their own `toJSON` (Prisma's
 * Decimal) through it; `undefined` fields are dropped.
 */
export function toJson(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value instanceof Map)
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [String(k), toJson(v)]),
    );
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const own = (value as { toJSON?: () => unknown }).toJSON;
      if (typeof own === "function") return toJson(own.call(value));
    }
    const out: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) out[key] = toJson(item);
    return out;
  }
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return value;
  return null;
}

/** Micros sent as a decimal string (or a JSON integer) as a bigint. */
export function microsIn(value: unknown): unknown {
  if (typeof value === "string" && /^\d{1,19}$/.test(value))
    return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return BigInt(value);
  return value;
}
