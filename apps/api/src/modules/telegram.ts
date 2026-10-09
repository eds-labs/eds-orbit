import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, list } from "../shared.ts";

/**
 * The project's linked Telegram chat, or null. Linking the bot (Task 12)
 * sets `linkedAt`; an agent review counts only if made after it (R50).
 *
 * Orbit Telegram bot (Orbit Agents, spec §10). For now only the question the
 * review authority needs (spec §6): is a Telegram chat linked to the
 * project? The bot's setup, webhook and messages follow in a later task.
 */
export async function linkedTelegramConnection(tx: DbTx, scope: Scope) {
  return (
    (await list(tx, scope, "telegram_connections")).find(
      (row) => data(row).status === "linked",
    ) ?? null
  );
}
