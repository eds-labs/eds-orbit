/**
 * Provider allow-list per data class (ADR 0021 addendum D-11, agent platform
 * Phase 2 plan §2.4 item 7). Personal customer data goes only to providers
 * covered by a recorded legal decision: Q-12a covers OpenAI under its DPA.
 * Anthropic stays excluded until it is reviewed. The list is a code constant
 * on purpose: widening it needs a recorded decision and a code change, not a
 * setting someone can flip.
 *
 * Checked before a reservation, so a refused call is never sent: by the task
 * host for an agent whose tools read customer data, and by the Support
 * triage and draft pipelines for every call.
 */
import type { ProviderId } from "../../../../../packages/ai/src/index.ts";
import { DomainError } from "../../shared.ts";

export type DataClass = "internal" | "customer_personal" | "financial";

const ALLOWED: Readonly<Record<Exclude<DataClass, "internal">, readonly ProviderId[]>> = {
  customer_personal: ["openai"],
  financial: ["openai"],
};

/** The providers that may receive data of this class. */
export function providersForData(dataClass: DataClass): readonly ProviderId[] | null {
  return dataClass === "internal" ? null : ALLOWED[dataClass];
}

/** Refuses AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA before anything is sent. */
export function assertProviderAllowedForData(provider: ProviderId, dataClass: DataClass | undefined) {
  if (!dataClass) return;
  const allowed = providersForData(dataClass);
  if (allowed && !allowed.includes(provider))
    throw new DomainError("AGENT_PROVIDER_NOT_ALLOWED_FOR_DATA", 409);
}

/** The strictest data class among tools' catalogue entries, or undefined. */
export function strictestDataClass(
  tools: ReadonlyArray<{ catalog?: { dataClass?: DataClass } }>,
): DataClass | undefined {
  const classes = new Set(tools.map((t) => t.catalog?.dataClass).filter(Boolean));
  if (classes.has("customer_personal")) return "customer_personal";
  if (classes.has("financial")) return "financial";
  return undefined;
}
