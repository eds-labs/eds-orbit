import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { AccountCredentials } from "../accounts/vault.ts";
import type { SocialPlatform } from "../accounts/store.ts";
import { instagramSender } from "./instagram.ts";
import { telegramSender } from "./telegram.ts";
import { xSender } from "./x.ts";

export { resultFromSocialError } from "./outcome.ts";

// One interface for every platform the dispatcher sends to (ADR 0020 §6.1,
// S5). A sender makes exactly one publish attempt and says what happened;
// it never retries a send itself.

export type SendInput = {
  publicationId: string;
  credentials: AccountCredentials;
  account: { externalId: string; handle: string; settings: { xLongPosts?: boolean } };
  body: string;
  options: Record<string, unknown>;
  media: Array<{
    fileId: string;
    bytes: Uint8Array;
    mime: "image/jpeg" | "image/png";
    width: number;
    height: number;
    publicUrl: string | null;
  }>;
  /** What an earlier attempt left (Instagram's workflow id); never tokens. */
  providerState: Record<string, unknown>;
};

export type SendResult =
  | { kind: "published"; externalPostId: string; permalink: string | null; providerState?: Record<string, unknown> }
  | { kind: "processing"; providerState: Record<string, unknown> }
  /** The provider says nothing was posted. */
  | { kind: "failed"; code: string; retry: "never" | "after-delay" | "after-reconnect"; delayMs?: number }
  /** Maybe posted: never sent again automatically. */
  | { kind: "unknown"; code: string; providerState?: Record<string, unknown> };

export interface SocialSender {
  send(scope: Scope, input: SendInput): Promise<SendResult>;
  /** Reads back after processing or an unknown outcome; never submits a new post. */
  reconcile?(scope: Scope, input: SendInput & { since: Date }): Promise<SendResult | { kind: "not_found" }>;
}

const senders: Partial<Record<SocialPlatform, SocialSender>> = { x: xSender, instagram: instagramSender, telegram: telegramSender };

/** The sender of a platform; Facebook has none yet. */
export const senderFor = (platform: SocialPlatform): SocialSender | null => senders[platform] ?? null;
