import type { Config } from "../../../../../packages/config/src/index.ts";

function originOf(value: string) {
  try {
    const { origin } = new URL(value);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * True while webmail is switched on and configured. Free of runtime imports:
 * the disabled bridge process loads this and Fastify, nothing else. An origin
 * shared with Orbit counts as not configured: a script in a displayed mail
 * would then act with the member's Orbit session (ADR 0026, E1).
 */
export function webmailConfigured(
  config: Pick<
    Config,
    "ORBIT_WEBMAIL" | "APP_ORIGIN" | "WEBMAIL_ORIGIN" | "WEBMAIL_BRIDGE_SECRET"
  >,
) {
  if (config.ORBIT_WEBMAIL !== "true" || config.WEBMAIL_BRIDGE_SECRET === "")
    return false;
  const origin = originOf(config.WEBMAIL_ORIGIN);
  return origin !== null && origin !== originOf(config.APP_ORIGIN);
}
