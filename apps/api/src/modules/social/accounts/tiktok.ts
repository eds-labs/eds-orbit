import { scoped } from "../../../../../../packages/db/src/index.ts";
import { z } from "zod";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import { saveConnectedAccount } from "./store.ts";

const input = z
  .object({
    handle: z
      .string()
      .trim()
      .regex(/^@?[a-zA-Z0-9_](?:[a-zA-Z0-9_.]{0,22}[a-zA-Z0-9_])?$/),
  })
  .strict();

export const TIKTOK_MANUAL = "SOCIAL_TIKTOK_MANUAL_REQUIRED";

export async function connectManualTikTok(scope: Scope, raw: unknown) {
  const handle = `@${input.parse(raw).handle.replace(/^@/, "").toLowerCase()}`;
  const existing = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    tx.socialAccount.findFirst({
      where: {
        projectId: scope.projectId,
        platform: "tiktok",
        externalId: handle,
        status: { not: "disabled" },
      },
      select: { id: true },
    }),
  );
  if (existing) return { accountId: existing.id };
  return saveConnectedAccount(scope, {
    platform: "tiktok",
    externalId: handle,
    handle,
    displayName: handle,
    secret: "{}",
    config: { manual: true },
    settings: { tiktokInbox: false },
  });
}

export function tiktokPostUrl(value: string | undefined, handle: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const [profile, kind, id, extra] = url.pathname.slice(1).split("/");
    if (
      url.protocol === "https:" &&
      ["www.tiktok.com", "tiktok.com"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      profile?.toLowerCase() === handle.toLowerCase() &&
      kind === "video" &&
      /^\d{10,25}$/.test(id ?? "") &&
      (extra === undefined || extra === "") &&
      url.pathname.split("/").length <= 5
    )
      return {
        id: id!,
        permalink: `https://www.tiktok.com/${profile}/video/${id}`,
      };
  } catch {
    return null;
  }
  return null;
}
