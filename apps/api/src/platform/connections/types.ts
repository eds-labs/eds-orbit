import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

/** The answer to one button press: shown to the owner, recorded as `handled`. */
export type TelegramCallbackResult = { handled: string; answer: string };

/**
 * Handles one button press of the owner's bot whose `callback_data` starts
 * with `<prefix>:` (WP2.5a). It runs inside the webhook's project transaction
 * with the linked owner's current role, never more. It returns null for data
 * it cannot verify; the platform then audits `telegram.callback_rejected`
 * and answers "invalid". Callback data is at most 64 bytes and must be signed
 * with `callbackMac`, so a click cannot be forged or replayed elsewhere.
 */
export type TelegramCallback = (
  tx: DbTx,
  actor: Scope,
  value: string,
  context: { connectionId: string },
) => Promise<TelegramCallbackResult | null>;

/** What the platform or a module contributes to the owner's Telegram bot. */
export type TelegramContribution = {
  /** The bot's routes and webhook exist while one contributor says so. */
  enabled?: () => boolean;
  /** Button callbacks by `callback_data` prefix (the part before ":"). */
  callbacks?: Readonly<Record<string, TelegramCallback>>;
};
