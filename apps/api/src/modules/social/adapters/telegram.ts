import { ConnectorError, createTelegramClient } from "../../../../../../packages/connectors/src/index.ts";
import { socialFetch } from "../accounts/http.ts";
import type { SendResult, SocialSender } from "./registry.ts";

// Telegram channels (ADR 0020 §8, S5) with the account's own publishing
// bot (S-D3), never the project's Orbit bot, through Orbit's connector. A
// text is one message, one image a photo with its caption, more images an
// album. A channel cannot be read back, so an unclear send stays with the
// owner to resolve.

function failure(error: unknown): SendResult {
  if (!(error instanceof ConnectorError)) return { kind: "unknown", code: "SOCIAL_PROVIDER_UNKNOWN" };
  if (error.outcome === "unknown") return { kind: "unknown", code: `SOCIAL_TELEGRAM_${error.code}` };
  if (error.code === "RATE_LIMITED")
    return { kind: "failed", code: "SOCIAL_RATE_LIMITED", retry: "after-delay", ...(error.retryAfterMs ? { delayMs: error.retryAfterMs } : {}) };
  if (error.code === "PROVIDER_AUTH") return { kind: "failed", code: "SOCIAL_ACCOUNT_RECONNECT_REQUIRED", retry: "after-reconnect" };
  return { kind: "failed", code: "SOCIAL_PROVIDER_REJECTED", retry: "never" };
}

export const telegramSender: SocialSender = {
  async send(_scope, input) {
    const chat = String(input.credentials.config.chatId ?? input.credentials.externalId);
    const silent = input.options.silent === true;
    try {
      const client = createTelegramClient({ token: input.credentials.accessToken, fetch: socialFetch });
      const ids =
        input.media.length === 0
          ? [(await client.sendMessage(chat, input.body, undefined, { disableLinkPreview: input.options.disableLinkPreview !== false, silent })).messageId]
          : input.media.length === 1
            ? [(await client.sendPhoto(chat, input.media[0]!.bytes, input.body, undefined, { silent, mime: input.media[0]!.mime })).messageId]
            : (await client.sendMediaGroup(chat, input.media.map((m) => ({ bytes: m.bytes, mime: m.mime })), input.body, { silent })).messageIds;
      const first = String(ids[0]);
      // A public channel's handle is "@name" (S2); a private one has no link.
      const name = input.account.handle.startsWith("@") ? input.account.handle.slice(1) : null;
      return {
        kind: "published",
        externalPostId: first,
        permalink: name ? `https://t.me/${name}/${first}` : null,
        providerState: { messageIds: ids },
      };
    } catch (error) {
      return failure(error);
    }
  },
};
