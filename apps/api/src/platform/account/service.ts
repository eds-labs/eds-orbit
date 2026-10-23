import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { authDb } from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { DomainError } from "../shared.ts";
import type { Auth } from "../tenancy/auth.ts";
import { withResetCapture } from "../tenancy/reset-capture.ts";
import {
  sendSystemMail,
  systemMailConfigured,
  systemMailTexts,
} from "../email/system-mail.ts";
import { systemAudit } from "../administration/audit.ts";

// A signed-in user's own account (ADR 0012): profile, language, password,
// sessions, password reset and e-mail change. Better Auth does the password
// work; Orbit owns the routes, their validation, the mail and the audit.
// No route here returns a session token or a reset token.

const password = z.string().min(12).max(128);
type Locale = "en" | "de";
const localeOf = (value: string | null | undefined): Locale =>
  value === "de" ? "de" : "en";
const origin = () => new URL(loadConfig().APP_ORIGIN).origin;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A Better Auth failure as a stable Orbit code. */
function authFailure(error: unknown, fallback: string): never {
  const code = (error as { body?: { code?: string } })?.body?.code;
  if (code === "INVALID_PASSWORD")
    throw new DomainError("INVALID_PASSWORD", 400);
  if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG")
    throw new DomainError(code, 400);
  throw new DomainError(fallback, 400);
}

export async function profile(userId: string) {
  const user = await authDb.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      locale: true,
      role: true,
      createdAt: true,
    },
  });
  if (!user) throw new DomainError("UNAUTHENTICATED", 401);
  const { role, ...rest } = user;
  return {
    ...rest,
    systemAdmin: role === "admin",
    emailChange: systemMailConfigured(),
  };
}

export const profileInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    locale: z.enum(["en", "de"]).nullable().optional(),
  })
  .strict();

export async function updateProfile(userId: string, raw: unknown) {
  const input = profileInput.parse(raw);
  await authDb.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    },
  });
  return profile(userId);
}

export const passwordChangeInput = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: password,
    revokeOtherSessions: z.boolean().default(false),
  })
  .strict();

/**
 * Changes the password. With `revokeOtherSessions` every other session ends
 * and Better Auth issues a new one; its cookie is returned to the caller.
 */
export async function changePassword(
  auth: Auth,
  userId: string,
  headers: Headers,
  raw: unknown,
) {
  const input = passwordChangeInput.parse(raw);
  let setCookies: string[] = [];
  try {
    const result = await auth.api.changePassword({
      body: input,
      headers,
      returnHeaders: true,
    });
    setCookies = result.headers?.getSetCookie() ?? [];
  } catch (error) {
    authFailure(error, "PASSWORD_CHANGE_FAILED");
  }
  await systemAudit({
    actorId: userId,
    action: "account.password_changed",
    targetType: "user",
    targetId: userId,
    metadata: { revokedOtherSessions: input.revokeOtherSessions },
  });
  return { changed: true, setCookies };
}

/** The user's sessions without tokens; the current one is marked. */
export async function listSessions(userId: string, currentId: string) {
  const rows = await authDb.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      createdAt: true,
      updatedAt: true,
      expiresAt: true,
      userAgent: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  return {
    items: rows.map((s) => ({
      ...s,
      userAgent: s.userAgent?.slice(0, 200) ?? null,
      current: s.id === currentId,
    })),
  };
}

export async function revokeSession(userId: string, sessionId: string) {
  const { count } = await authDb.session.deleteMany({
    where: { id: z.string().max(100).parse(sessionId), userId },
  });
  if (!count) throw new DomainError("NOT_FOUND", 404);
  await systemAudit({
    actorId: userId,
    action: "account.session_revoked",
    targetType: "session",
    targetId: sessionId,
  });
  return { revoked: 1 };
}

export async function revokeOtherSessions(userId: string, currentId: string) {
  const { count } = await authDb.session.deleteMany({
    where: { userId, id: { not: currentId } },
  });
  await systemAudit({
    actorId: userId,
    action: "account.sessions_revoked",
    targetType: "user",
    targetId: userId,
    metadata: { sessions: count },
  });
  return { revoked: count };
}

/** Self-service password reset is offered only with system mail. */
export const passwordResetAvailable = () => systemMailConfigured();

const resetLink = (token: string) => `${origin()}/reset-password#${token}`;

async function issueResetToken(auth: Auth, email: string) {
  return withResetCapture(() =>
    auth.api.requestPasswordReset({ body: { email } }),
  );
}

export const resetRequestInput = z
  .object({ email: z.email().max(254) })
  .strict();

/**
 * Requests a reset link by e-mail. The answer is the same whether or not
 * the address belongs to an active account, and the mail is sent after the
 * answer, so neither the response nor its timing reveals accounts.
 */
export async function requestPasswordReset(
  auth: Auth,
  raw: unknown,
  log: (code: string) => void,
) {
  const { email } = resetRequestInput.parse(raw);
  if (!passwordResetAvailable())
    throw new DomainError("PASSWORD_RESET_UNAVAILABLE", 404);
  const address = email.trim().toLowerCase();
  void (async () => {
    const user = await authDb.user.findUnique({
      where: { email: address },
      select: { id: true, banned: true, locale: true },
    });
    if (!user || user.banned) return;
    const token = await issueResetToken(auth, address);
    if (!token) return log("PASSWORD_RESET_NO_TOKEN");
    const result = await sendSystemMail({
      to: address,
      ...systemMailTexts.passwordReset(localeOf(user.locale), {
        link: resetLink(token),
      }),
    });
    if (result.status === "failed") log(result.code);
    await systemAudit({
      actorId: user.id,
      action: "account.password_reset_requested",
      targetType: "user",
      targetId: user.id,
      metadata: { delivery: result.status },
    });
  })().catch(() => log("PASSWORD_RESET_FAILED"));
  return { requested: true };
}

/**
 * An administrator's reset for a user: mailed when system mail is
 * available, otherwise the link is returned once for the administrator to
 * pass on. The user's sessions end when the new password is set.
 */
export async function adminPasswordReset(
  auth: Auth,
  actorId: string,
  userId: string,
) {
  const user = await authDb.user.findUnique({
    where: { id: userId },
    select: { email: true, banned: true, locale: true },
  });
  if (!user) throw new DomainError("USER_NOT_FOUND", 404);
  if (user.banned) throw new DomainError("USER_DEACTIVATED", 409);
  const token = await issueResetToken(auth, user.email);
  if (!token) throw new DomainError("PASSWORD_RESET_FAILED", 409);
  const link = resetLink(token);
  const result = await sendSystemMail({
    to: user.email,
    ...systemMailTexts.passwordReset(localeOf(user.locale), { link }),
  });
  await systemAudit({
    actorId,
    action: "user.password_reset_issued",
    targetType: "user",
    targetId: userId,
    metadata: { delivery: result.status === "sent" ? "email" : "link" },
  });
  return result.status === "sent"
    ? { delivery: "email" as const }
    : { delivery: "link" as const, link };
}

export const resetConfirmInput = z
  .object({ token: z.string().min(10).max(200), newPassword: password })
  .strict();

/** Sets a new password with a reset token (single use, one hour). */
export async function confirmPasswordReset(auth: Auth, raw: unknown) {
  const input = resetConfirmInput.parse(raw);
  try {
    await auth.api.resetPassword({
      body: { token: input.token, newPassword: input.newPassword },
    });
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code;
    if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG")
      throw new DomainError(code, 400);
    throw new DomainError("INVALID_TOKEN", 400);
  }
  return { reset: true };
}

const EMAIL_CHANGE = "orbit-email-change:";

export const emailChangeInput = z
  .object({ newEmail: z.email().max(254), password: z.string().min(1).max(128) })
  .strict();

/**
 * Sends a confirmation link to a new address. The current password is
 * required and the address only changes once the link is opened.
 */
export async function requestEmailChange(
  auth: Auth,
  userId: string,
  headers: Headers,
  raw: unknown,
) {
  const input = emailChangeInput.parse(raw);
  if (!systemMailConfigured())
    throw new DomainError("SYSTEM_MAIL_UNAVAILABLE", 409);
  try {
    await auth.api.verifyPassword({ body: { password: input.password }, headers });
  } catch (error) {
    authFailure(error, "INVALID_PASSWORD");
  }
  const newEmail = input.newEmail.trim().toLowerCase();
  const user = await authDb.user.findUnique({
    where: { id: userId },
    select: { email: true, locale: true },
  });
  if (!user) throw new DomainError("UNAUTHENTICATED", 401);
  if (user.email === newEmail) throw new DomainError("EMAIL_UNCHANGED", 409);
  if (await authDb.user.findUnique({ where: { email: newEmail } }))
    throw new DomainError("EMAIL_IN_USE", 409);
  const token = randomBytes(32).toString("base64url");
  await authDb.verification.deleteMany({
    where: { identifier: { startsWith: EMAIL_CHANGE }, value: { contains: userId } },
  });
  await authDb.verification.create({
    data: {
      id: crypto.randomUUID(),
      identifier: EMAIL_CHANGE + sha256(token),
      value: JSON.stringify({ userId, newEmail }),
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  });
  const result = await sendSystemMail({
    to: newEmail,
    ...systemMailTexts.emailChange(localeOf(user.locale), {
      link: `${origin()}/account/confirm-email#${token}`,
    }),
  });
  if (result.status !== "sent" && result.status !== "test_receipt")
    throw new DomainError("SYSTEM_MAIL_UNAVAILABLE", 409);
  await systemAudit({
    actorId: userId,
    action: "account.email_change_requested",
    targetType: "user",
    targetId: userId,
  });
  return { sent: true };
}

export const emailConfirmInput = z
  .object({ token: z.string().min(20).max(200) })
  .strict();

/** Confirms a new address for the signed-in user who requested it. */
export async function confirmEmailChange(userId: string, raw: unknown) {
  const { token } = emailConfirmInput.parse(raw);
  const identifier = EMAIL_CHANGE + sha256(token);
  const row = await authDb.verification.findFirst({ where: { identifier } });
  const value = row
    ? (JSON.parse(row.value) as { userId: string; newEmail: string })
    : null;
  if (!row || !value || row.expiresAt <= new Date() || value.userId !== userId)
    throw new DomainError("INVALID_TOKEN", 400);
  const previous = await authDb.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true, locale: true },
    });
    if (!user) throw new DomainError("UNAUTHENTICATED", 401);
    if (await tx.user.findUnique({ where: { email: value.newEmail } }))
      throw new DomainError("EMAIL_IN_USE", 409);
    const consumed = await tx.verification.deleteMany({ where: { identifier } });
    if (!consumed.count) throw new DomainError("INVALID_TOKEN", 400);
    await tx.user.update({
      where: { id: userId },
      data: { email: value.newEmail, emailVerified: true },
    });
    await systemAudit(
      {
        actorId: userId,
        action: "account.email_changed",
        targetType: "user",
        targetId: userId,
      },
      tx,
    );
    return user;
  });
  // The previous address learns about the change.
  await sendSystemMail({
    to: previous.email,
    ...systemMailTexts.emailChanged(localeOf(previous.locale)),
  });
  return profile(userId);
}
