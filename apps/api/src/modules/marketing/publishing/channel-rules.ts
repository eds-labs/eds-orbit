import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { data, list } from "../../../shared.ts";
import {
  assignedPostizChannels,
  hasXLongPosts,
  postingTimeFor,
} from "./postiz-assignment.ts";
import { connectionVerified } from "../../../platform/connections/connections.ts";
import { creativeStudioEnabled } from "../creative/flag.ts";

/** Preflight blocker: a post on a channel that rejects text-only posts has no image (Creative Studio on). */
export const MEDIA_REQUIRED = "MEDIA_REQUIRED";

type CountingMethod = "conservative_x_weighted" | "utf16_units";
export type ChannelRules = {
  providerIdentifier: string | null;
  connectorId: string | null;
  connectorVersion: number | null;
  characterLimit: number | null;
  countingMethod: CountingMethod | null;
  liveCapabilityKnown: boolean;
  /** The provider rejects a post without an image (Instagram, with the Creative Studio on). */
  mediaRequired: boolean;
  postingTime?: string | null;
};

// Providers whose rules come with the Creative Studio (R64): while it is off
// they stay unknown providers, as before it (CS-D6).
const STUDIO_PROVIDERS = ["instagram", "instagram-standalone", "facebook"];

/** Resolve the actual assigned Postiz provider, never the integration ID or display name. */
export async function resolveChannelRules(
  tx: DbTx,
  scope: Scope,
  integrationId: string,
  contentType: string,
  hasAsset: boolean,
): Promise<ChannelRules> {
  const unknown: ChannelRules = {
    providerIdentifier: null,
    connectorId: null,
    connectorVersion: null,
    characterLimit: null,
    countingMethod: null,
    liveCapabilityKnown: false,
    mediaRequired: false,
  };
  if (contentType !== "social") return unknown;
  const matches = (await list(tx, scope, "connectors"))
    .filter(
      (row) =>
        data(row).provider === "postiz" && connectionVerified(data(row).status),
    )
    .flatMap((row) =>
      assignedPostizChannels(data(row))
        .filter((channel: any) => channel.id === integrationId)
        .map((channel: any) => ({ row, channel })),
    );
  if (matches.length !== 1) return unknown;
  const { row, channel } = matches[0]!;
  const providerIdentifier =
    typeof channel.identifier === "string" ? channel.identifier : null;
  const common = {
    providerIdentifier,
    connectorId: row.id,
    connectorVersion: row.version,
    postingTime: postingTimeFor(data(row), channel.id),
  };
  if (
    STUDIO_PROVIDERS.includes(providerIdentifier ?? "") &&
    !creativeStudioEnabled()
  )
    return { ...unknown, ...common };
  switch (providerIdentifier) {
    case "x":
      return {
        ...common,
        // Postiz allows 4,000 characters for X Premium (verified) accounts.
        characterLimit: hasXLongPosts(data(row), channel.id) ? 4_000 : 280,
        countingMethod: "conservative_x_weighted",
        liveCapabilityKnown: true,
        mediaRequired: false,
      };
    case "telegram":
      return {
        ...common,
        // Postiz sends attached media with the text as a Telegram caption.
        characterLimit: hasAsset ? 1024 : 4096,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
        mediaRequired: false,
      };
    case "linkedin":
      return {
        ...common,
        characterLimit: 3000,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
        mediaRequired: false,
      };
    case "instagram":
    case "instagram-standalone":
      return {
        ...common,
        // Postiz: "Instagram should have at least one attachment", caption up to 2,200.
        characterLimit: 2200,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
        mediaRequired: true,
      };
    case "facebook":
      return {
        ...common,
        // Postiz allows 63,206, but its client sends at most 50,000 characters
        // (createSchema in packages/connectors): the stricter bound is the limit.
        characterLimit: 50_000,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
        mediaRequired: false,
      };
    default:
      return { ...unknown, ...common };
  }
}

const CLOSING_HASHTAGS = /\n\n((?:#[\p{L}\p{N}_]+[ \t]*)+)$/u;

/**
 * The exact plain text passed to Postiz, including an otherwise missing target
 * URL: after the call to action, before a closing hashtag line, at the same length.
 */
export function finalPostText(body: string, targetUrl?: string | null) {
  if (!targetUrl || body.includes(targetUrl)) return body;
  const tags = body.match(CLOSING_HASHTAGS);
  if (!tags) return body + "\n" + targetUrl;
  return `${body.slice(0, tags.index)}\n${targetUrl}\n\n${tags[1]}`;
}

/** X uses weighted Unicode and 23-character URLs. Add the URL allowance to raw text so trailing punctuation and unparsed links cannot undercount. */
export function channelTextLength(
  text: string,
  rules: ChannelRules,
): number | null {
  if (rules.countingMethod === "utf16_units") return text.length;
  if (rules.countingMethod !== "conservative_x_weighted") return null;
  const weight = (part: string) =>
    Array.from(part).reduce(
      (sum, char) => sum + (char.codePointAt(0)! <= 0x7f ? 1 : 2),
      0,
    );
  const urlLike =
    /https?:\/\/|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b/iu;
  const possibleLinks = text
    .split(/\s+/u)
    .filter((token) => urlLike.test(token));
  return weight(text) + 23 * possibleLinks.length;
}

export function channelLimitExceeded(
  body: string,
  targetUrl: string | null | undefined,
  rules: ChannelRules,
) {
  const length = channelTextLength(finalPostText(body, targetUrl), rules);
  return (
    length !== null &&
    rules.characterLimit !== null &&
    length > rules.characterLimit
  );
}
