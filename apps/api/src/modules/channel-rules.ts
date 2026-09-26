import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, list } from "../shared.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";

type CountingMethod = "conservative_x_weighted" | "utf16_units";
export type ChannelRules = {
  providerIdentifier: string | null;
  connectorId: string | null;
  connectorVersion: number | null;
  characterLimit: number | null;
  countingMethod: CountingMethod | null;
  liveCapabilityKnown: boolean;
};

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
  };
  if (contentType !== "social") return unknown;
  const matches = (await list(tx, scope, "connectors"))
    .filter(
      (row) =>
        data(row).provider === "postiz" &&
        ["read_verified", "write_verified"].includes(data(row).status),
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
  };
  switch (providerIdentifier) {
    case "x":
      return {
        ...common,
        characterLimit: 280,
        countingMethod: "conservative_x_weighted",
        liveCapabilityKnown: true,
      };
    case "telegram":
      return {
        ...common,
        // Postiz sends attached media with the text as a Telegram caption.
        characterLimit: hasAsset ? 1024 : 4096,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
      };
    case "linkedin":
      return {
        ...common,
        characterLimit: 3000,
        countingMethod: "utf16_units",
        liveCapabilityKnown: true,
      };
    default:
      return { ...unknown, ...common };
  }
}

/** The exact plain text passed to Postiz, including an otherwise missing target URL. */
export function finalPostText(body: string, targetUrl?: string | null) {
  return (
    body + (targetUrl && !body.includes(targetUrl) ? "\n" + targetUrl : "")
  );
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
