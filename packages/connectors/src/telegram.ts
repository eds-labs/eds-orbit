import { z } from "zod";
import {
  boundedFetch,
  ConnectorError,
  providerDetail,
  type FetchLike,
} from "./http.ts";

/**
 * Telegram Bot API client for the owner's private Orbit bot (Orbit Agents,
 * spec §10). Fixed endpoint `https://api.telegram.org/bot<token>/<method>`;
 * the token lives only in that URL and never in a header, an error or a
 * return value. Authorization, the bound chat and durable intent belong to
 * the server module that calls it.
 */
const TOKEN = /^\d{5,16}:[A-Za-z0-9_-]{30,100}$/;
// Telegram's own limits: secret_token 1-256 of [A-Za-z0-9_-], callback_data 1-64 bytes.
const SECRET = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type TelegramButton =
  | { text: string; callbackData: string; url?: never }
  | { text: string; url: string; callbackData?: never };
export type TelegramChatId = number | string;
export type TelegramClientOptions = {
  token: string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

const sentMessage = z.object({ message_id: z.number().int() }).passthrough();

function keyboard(buttons: TelegramButton[] | undefined) {
  if (!buttons?.length) return undefined;
  if (buttons.length > 8) throw new ConnectorError("INVALID_TELEGRAM_BUTTON");
  return {
    inline_keyboard: [
      buttons.map((button) => {
        if (!button.text?.trim() || button.text.length > 64)
          throw new ConnectorError("INVALID_TELEGRAM_BUTTON");
        if (typeof button.callbackData === "string") {
          const size = Buffer.byteLength(button.callbackData);
          if (size < 1 || size > 64)
            throw new ConnectorError("INVALID_TELEGRAM_BUTTON");
          return { text: button.text, callback_data: button.callbackData };
        }
        let url: URL;
        try {
          url = new URL(String(button.url));
        } catch {
          throw new ConnectorError("INVALID_TELEGRAM_BUTTON");
        }
        if (url.protocol !== "https:" && url.protocol !== "http:")
          throw new ConnectorError("INVALID_TELEGRAM_BUTTON");
        return { text: button.text, url: url.toString() };
      }),
    ],
  };
}

function chat(chatId: TelegramChatId) {
  if (
    (typeof chatId === "number" && Number.isSafeInteger(chatId)) ||
    (typeof chatId === "string" && /^-?\d{1,20}$/.test(chatId))
  )
    return chatId;
  throw new ConnectorError("INVALID_TELEGRAM_CHAT");
}

export function createTelegramClient(options: TelegramClientOptions) {
  if (typeof options.token !== "string" || !TOKEN.test(options.token))
    throw new ConnectorError("INVALID_TELEGRAM_TOKEN");
  const base = `https://api.telegram.org/bot${options.token}/`;
  const fetcher = options.fetch ?? boundedFetch;
  const timeoutMs = Math.min(options.timeoutMs ?? 10_000, 10_000);

  /** One Bot API call. A send whose outcome is unclear is `unknown`, never retried here. */
  async function call(
    method: string,
    body: Record<string, unknown> | FormData,
    sideEffect: boolean,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetcher(base + method, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          ...(body instanceof FormData
            ? { body, headers: { Accept: "application/json" } }
            : {
                body: JSON.stringify(body),
                headers: {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                },
              }),
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        // The cause may carry the request URL, and with it the token: never kept.
        const timedOut = controller.signal.aborted;
        throw new ConnectorError(
          timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
          sideEffect ? "unknown" : "not_sent",
          !sideEffect,
        );
      }
      if (!response.ok) {
        const detail = await providerDetail(response);
        const ambiguous =
          sideEffect && (response.status >= 500 || response.status === 408);
        throw new ConnectorError(
          response.status === 401 ||
            response.status === 403 ||
            response.status === 404
            ? "PROVIDER_AUTH"
            : response.status === 429
              ? "RATE_LIMITED"
              : "PROVIDER_REJECTED",
          ambiguous ? "unknown" : "rejected",
          !ambiguous && (response.status === 429 || response.status >= 500),
          response.status,
          detail,
        );
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES)
        throw new ConnectorError(
          "RESPONSE_TOO_LARGE",
          sideEffect ? "unknown" : "rejected",
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ConnectorError(
          "INVALID_PROVIDER_RESPONSE",
          sideEffect ? "unknown" : "rejected",
        );
      }
      const envelope = z
        .object({ ok: z.boolean(), result: z.unknown().optional() })
        .safeParse(parsed);
      if (!envelope.success)
        throw new ConnectorError(
          "INVALID_PROVIDER_RESPONSE",
          sideEffect ? "unknown" : "rejected",
        );
      if (!envelope.data.ok)
        throw new ConnectorError("PROVIDER_REJECTED", "rejected");
      return envelope.data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  function receipt(result: unknown) {
    const parsed = sentMessage.safeParse(result);
    if (!parsed.success)
      throw new ConnectorError("INVALID_PROVIDER_RESPONSE", "unknown");
    return { messageId: parsed.data.message_id };
  }

  return {
    async sendMessage(
      chatId: TelegramChatId,
      text: string,
      buttons?: TelegramButton[],
    ) {
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT)
        throw new ConnectorError("INVALID_TELEGRAM_MESSAGE");
      const markup = keyboard(buttons);
      return receipt(
        await call(
          "sendMessage",
          {
            chat_id: chat(chatId),
            text,
            link_preview_options: { is_disabled: true },
            ...(markup ? { reply_markup: markup } : {}),
          },
          true,
        ),
      );
    },
    async sendPhoto(
      chatId: TelegramChatId,
      bytes: Uint8Array,
      caption: string,
      buttons?: TelegramButton[],
    ) {
      if (
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > MAX_PHOTO_BYTES ||
        typeof caption !== "string" ||
        caption.length > MAX_CAPTION
      )
        throw new ConnectorError("INVALID_TELEGRAM_MESSAGE");
      const markup = keyboard(buttons);
      const form = new FormData();
      form.set("chat_id", String(chat(chatId)));
      form.set("photo", new Blob([new Uint8Array(bytes)]), "preview");
      if (caption) form.set("caption", caption);
      if (markup) form.set("reply_markup", JSON.stringify(markup));
      return receipt(await call("sendPhoto", form, true));
    },
    async setWebhook(url: string, secretToken: string) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new ConnectorError("INVALID_TELEGRAM_WEBHOOK");
      }
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        typeof secretToken !== "string" ||
        !SECRET.test(secretToken)
      )
        throw new ConnectorError("INVALID_TELEGRAM_WEBHOOK");
      await call(
        "setWebhook",
        {
          url: target.toString(),
          secret_token: secretToken,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true,
        },
        false,
      );
    },
    async deleteWebhook() {
      await call("deleteWebhook", { drop_pending_updates: true }, false);
    },
    async answerCallbackQuery(id: string, text: string) {
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 128 ||
        typeof text !== "string" ||
        text.length > 200
      )
        throw new ConnectorError("INVALID_TELEGRAM_MESSAGE");
      await call(
        "answerCallbackQuery",
        { callback_query_id: id, ...(text ? { text } : {}) },
        false,
      );
    },
  };
}
export type TelegramClient = ReturnType<typeof createTelegramClient>;
