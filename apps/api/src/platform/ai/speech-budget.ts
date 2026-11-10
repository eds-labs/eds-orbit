import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  speechBudgetCategory,
  speechCostMicros,
  type ResolvedSpeechRoute,
} from "../../../../../packages/ai/src/index.ts";
import { markTransmitted, reserve, settle } from "./budget.ts";
import { requireSpendMandate } from "./spend-mandate.ts";

/**
 * Audio pricing on top of the existing reservation flow (ADR 0024, WP4.5):
 * a speech call is estimated from what the server measured (seconds of a
 * recording, characters of a text), reserved under `speech_stt` or
 * `speech_tts` before the call and settled with the actual usage. Token
 * pricing and `reserve`/`settle` themselves are unchanged.
 */

/** The estimate of a speech call in USD micros (seconds for STT, characters for TTS). */
export function estimateSpeechMicros(
  route: ResolvedSpeechRoute,
  quantity: number,
) {
  return speechCostMicros(route.price, quantity);
}

/**
 * Reserves the estimate within the space's spending authority and marks the
 * reservation as transmitted, in the caller's transaction. Throws the
 * reservation's own codes (POLICY_REQUIRED, BUDGET_EXCEEDED, ...).
 */
export async function reserveSpeech(
  tx: DbTx,
  scope: Scope,
  route: ResolvedSpeechRoute,
  estimateMicros: number,
  key: string,
) {
  const mandate = await requireSpendMandate(tx, scope);
  const reservation = await reserve(
    tx,
    scope,
    key,
    speechBudgetCategory[route.taskClass],
    estimateMicros,
    mandate.limits,
    new Date(),
    key,
    { taskClass: route.taskClass, model: route.model },
  );
  await markTransmitted(tx, scope, reservation.id);
  return reservation.id;
}

/**
 * Settles a speech reservation:
 * - `{ quantity }`: the actual seconds or characters, priced like the estimate;
 * - `"not_billed"`: nothing was sent or the provider refused it (0);
 * - `"unknown"`: transmitted with an unclear outcome; never retried.
 */
export async function settleSpeech(
  tx: DbTx,
  scope: Scope,
  reservationId: string,
  route: ResolvedSpeechRoute,
  outcome: { quantity: number } | "not_billed" | "unknown",
) {
  const actual =
    outcome === "unknown"
      ? null
      : outcome === "not_billed"
        ? 0
        : speechCostMicros(route.price, outcome.quantity);
  await settle(tx, scope, reservationId, actual);
  return actual;
}
