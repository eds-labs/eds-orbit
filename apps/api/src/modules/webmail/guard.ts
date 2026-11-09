import type { Config } from "../../../../../packages/config/src/index.ts";

/**
 * True while webmail is switched on and configured. Free of runtime imports:
 * the disabled bridge process loads this and Fastify, nothing else.
 */
export function webmailConfigured(
  config: Pick<
    Config,
    "ORBIT_WEBMAIL" | "WEBMAIL_ORIGIN" | "WEBMAIL_BRIDGE_SECRET"
  >,
) {
  return (
    config.ORBIT_WEBMAIL === "true" &&
    config.WEBMAIL_ORIGIN !== "" &&
    config.WEBMAIL_BRIDGE_SECRET !== ""
  );
}
