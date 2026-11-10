import { z } from "zod";
import { createTelegramClient } from "../../../../../../packages/connectors/src/index.ts";
import { scoped } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { isOwnerBotToken } from "../../../platform/connections/telegram.ts";
import { DomainError } from "../../../shared.ts";
import { providerFailure } from "./errors.ts";
import { socialFetch } from "./http.ts";
import { saveConnectedAccount } from "./store.ts";

// Telegram publishing channels and groups (ADR 0020, S-D3): a separate bot,
// entered by the owner, that is an administrator allowed to post in the
// channel, or a member allowed to write in the group. Private chats are not
// accounts.
// Only outgoing reads here: never getUpdates, setWebhook, deleteWebhook,
// logOut or close, so no other process's webhook is disturbed.

const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/;
const CHAT = /^(@[A-Za-z][A-Za-z0-9_]{4,31}|-?\d{1,20})$/;

export const telegramChannelInput = z
  .object({ botToken: z.string().max(200), chat: z.string().trim().max(64) })
  .strict();

export async function connectTelegramChannel(
  scope: Scope,
  raw: unknown,
): Promise<{ accountId: string }> {
  const parsed = telegramChannelInput.safeParse(raw);
  // The token never appears in a validation error.
  if (!parsed.success || !TOKEN.test(parsed.data.botToken))
    throw new DomainError("SOCIAL_TELEGRAM_TOKEN_INVALID", 400);
  const { botToken, chat } = parsed.data;
  if (!CHAT.test(chat)) throw new DomainError("SOCIAL_TELEGRAM_CHAT_INVALID", 400);
  if (await scoped(scope.workspaceId, scope.projectId, (tx) => isOwnerBotToken(tx, scope, botToken)))
    throw new DomainError("SOCIAL_TELEGRAM_OWNER_BOT", 409);
  const client = createTelegramClient({ token: botToken, fetch: socialFetch });
  let bot, info, member;
  try {
    bot = await client.getMe();
    info = await client
      .getChat(chat.startsWith("@") ? (chat as `@${string}`) : chat)
      .catch((error: unknown) => {
        // Telegram answers an unknown or inaccessible chat with 400.
        if ((error as { status?: number }).status === 400)
          throw new DomainError("SOCIAL_TELEGRAM_CHAT_INVALID", 400);
        throw error;
      });
    if (info.type === "private") throw new DomainError("SOCIAL_TELEGRAM_PRIVATE_CHAT", 409);
    member = await client.getChatMember(info.id, bot.id);
  } catch (error) {
    throw providerFailure(error);
  }
  if (!telegramMayPost(info.type, member)) throw new DomainError("SOCIAL_TELEGRAM_BOT_CANNOT_POST", 409);
  const handle = info.username ? `@${info.username}` : (info.title ?? String(info.id));
  return saveConnectedAccount(scope, {
    platform: "telegram",
    externalId: String(info.id),
    handle,
    displayName: info.title ?? handle,
    secret: JSON.stringify({ botToken }),
    config: { chatId: String(info.id), chatType: info.type, botId: String(bot.id), botUsername: bot.username },
  });
}

/** Whether the bot may publish: a channel needs the posting right, a group a writing member. Accounts from before groups have no `chatType` and are channels. */
export function telegramMayPost(
  chatType: unknown,
  member: { canPostMessages: boolean; canSendMessages: boolean },
): boolean {
  return chatType === "group" || chatType === "supergroup" ? member.canSendMessages : member.canPostMessages;
}
