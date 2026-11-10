import { createTelegramClient } from "../../../../../../packages/connectors/src/index.ts";
import { scoped, type Prisma } from "../../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../../packages/schemas/src/index.ts";
import type { PeriodicTask } from "../../../platform/jobs/types.ts";
import { audit, DomainError } from "../../../shared.ts";
import { socialActive } from "../gate.ts";
import { appCredentials } from "./apps.ts";
import { providerFailure, responseFailure } from "./errors.ts";
import { socialFetch } from "./http.ts";
import { metaHealth } from "./meta.ts";
import { telegramMayPost } from "./telegram.ts";
import { accountCredentials, markReconnectRequired } from "./vault.ts";
import { X_USER } from "./x.ts";

// Account health (ADR 0020): a read per platform that proves the stored
// credentials still work. A refusal marks the account for a reconnect; an
// outage is only recorded. Runs on demand and every six hours, at most 20
// accounts per project and run, the least recently checked first.

const EVERY_MS = 6 * 60 * 60_000;
const PER_RUN = 20;

type Result = { ok: true } | { ok: false; code: string };

async function probe(scope: Scope, accountId: string, manual: boolean): Promise<Result> {
  const credentials = await accountCredentials(scope, accountId, { allowReconnect: manual });
  if (credentials.platform === "x") {
    const response = await socialFetch(X_USER, {
      headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: "application/json" },
    });
    if (response.ok) return { ok: true };
    throw responseFailure(response);
  }
  if (credentials.platform === "telegram") {
    const member = await createTelegramClient({ token: credentials.accessToken, fetch: socialFetch }).getChatMember(
      String(credentials.config.chatId),
      Number(credentials.config.botId),
    );
    return telegramMayPost(credentials.config.chatType, member)
      ? { ok: true }
      : { ok: false, code: "SOCIAL_TELEGRAM_BOT_CANNOT_POST" };
  }
  const app = await scoped(scope.workspaceId, scope.projectId, (tx) => appCredentials(tx, scope, "meta"));
  const health = await metaHealth(app.meta!, credentials.accessToken, credentials.platform, credentials.externalId);
  return health.ok ? { ok: true } : health;
}

async function record(scope: Scope, accountId: string, result: Result, refused: boolean) {
  await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    // The project explicitly, not only through row-level security.
    const row = await tx.socialAccount.findFirst({
      where: { id: accountId, projectId: scope.projectId },
      select: { settings: true },
    });
    await tx.socialAccount.update({
      where: { id: accountId, projectId: scope.projectId },
      data: {
        settings: {
          ...((row?.settings as object) ?? {}),
          lastCheckedAt: new Date().toISOString(),
          lastCheckCode: result.ok ? null : result.code,
        } as Prisma.InputJsonObject,
      },
    });
    if (refused && !result.ok) await markReconnectRequired(tx, scope, accountId, result.code);
    if (result.ok) {
      const restored = await tx.socialAccount.updateMany({
        where: { id: accountId, projectId: scope.projectId, status: "reconnect_required" },
        data: { status: "active", version: { increment: 1 } },
      });
      if (restored.count === 1) await audit(tx, scope, "social.account.restored", accountId, {});
    }
  });
}

/**
 * Checks one account; never throws for a provider answer. An owner's check
 * (`manual`) also probes an account that awaits a reconnect and restores it
 * when the cause is gone (e.g. a Telegram bot got its posting right back).
 */
export async function checkAccount(scope: Scope, accountId: string, options: { manual?: boolean } = {}): Promise<Result> {
  let result: Result;
  let refused = false;
  try {
    result = await probe(scope, accountId, options.manual === true);
    refused = !result.ok;
  } catch (error) {
    const failure = providerFailure(error);
    if (failure.code === "NOT_FOUND" || failure.code === "SOCIAL_ACCOUNT_DISABLED") throw failure;
    refused = failure.code === "SOCIAL_PROVIDER_REJECTED";
    result = { ok: false, code: failure.code };
  }
  await record(scope, accountId, result, refused);
  return result;
}

const lastChecked = (settings: unknown) => {
  const at = (settings as { lastCheckedAt?: string }).lastCheckedAt;
  return at ? Date.parse(at) : 0;
};

export const socialAccountHealth: PeriodicTask = {
  name: "social-account-health",
  async nextDueAt(tx, scope) {
    if (!(await socialActive(tx, scope))) return null;
    const active = await tx.socialAccount.findMany({
      where: { projectId: scope.projectId, status: "active" },
      select: { settings: true },
    });
    if (!active.length) return null;
    return new Date(Math.min(...active.map((a) => lastChecked(a.settings))) + EVERY_MS);
  },
  async run(scope) {
    const due = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
      if (!(await socialActive(tx, scope))) return [];
      const active = await tx.socialAccount.findMany({
        where: { projectId: scope.projectId, status: "active" },
        select: { id: true, settings: true },
      });
      return active
        .filter((a) => lastChecked(a.settings) + EVERY_MS <= Date.now())
        .sort((a, b) => lastChecked(a.settings) - lastChecked(b.settings))
        .slice(0, PER_RUN);
    });
    let failed = 0;
    for (const account of due) {
      try {
        if (!(await checkAccount(scope, account.id)).ok) failed++;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        failed++;
      }
    }
    return { status: `checked ${due.length}, failed ${failed}`, wakeAt: new Date(Date.now() + EVERY_MS) };
  },
};
