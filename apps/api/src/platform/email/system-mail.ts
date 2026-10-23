import { randomUUID } from "node:crypto";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import { liveSending } from "./connection.ts";
import { MailSendError, smtpSession, type OutgoingMail } from "./transport.ts";

// System authentication mail (ADR 0012): invitations, password reset and
// e-mail change. It uses the operator's system SMTP account from the
// environment, never a project mailbox, and the same SMTP session code as
// project mail. The host is operator configuration, so an internal relay is
// allowed (unlike project mailboxes). Links carry one-time tokens: they are
// never logged, audited or kept here; failures keep only codes.

export type SystemMail = { to: string; subject: string; text: string };
export type SystemMailResult =
  | { status: "sent" }
  | { status: "test_receipt" }
  | { status: "not_configured" }
  | { status: "failed"; code: string };

const TIMEOUT_MS = 15_000;

/** Whether a system sender is configured (host and from address). */
export function systemMailConfigured() {
  const c = loadConfig();
  return Boolean(c.ORBIT_SYSTEM_SMTP_HOST && c.ORBIT_SYSTEM_SMTP_FROM);
}

type Sink = (mail: SystemMail) => void;
let sink: Sink | null = null;
/** Tests capture system mail here; null restores real delivery rules. */
export function setSystemMailSinkForTests(next: Sink | null) {
  sink = next;
}

/** Sends one system message, or reports why it did not go out. */
export async function sendSystemMail(
  mail: SystemMail,
): Promise<SystemMailResult> {
  if (sink) {
    sink(mail);
    return { status: "test_receipt" };
  }
  if (!systemMailConfigured()) return { status: "not_configured" };
  // Outside live mode nothing is delivered; the caller falls back to a link.
  if (!liveSending()) return { status: "test_receipt" };
  const c = loadConfig();
  const from = c.ORBIT_SYSTEM_SMTP_FROM!;
  const outgoing: OutgoingMail = {
    from: { address: from, name: c.ORBIT_SYSTEM_SMTP_FROM_NAME },
    to: [mail.to],
    subject: mail.subject,
    text: mail.text,
    messageId: `<${randomUUID()}@${from.split("@")[1]}>`,
    headers: { "Auto-Submitted": "auto-generated" },
  };
  try {
    const result = await smtpSession(
      {
        options: {
          host: c.ORBIT_SYSTEM_SMTP_HOST!,
          port: c.ORBIT_SYSTEM_SMTP_PORT,
          secure: c.ORBIT_SYSTEM_SMTP_TLS === "implicit",
          requireTLS: c.ORBIT_SYSTEM_SMTP_TLS === "starttls",
          connectionTimeout: TIMEOUT_MS,
          greetingTimeout: TIMEOUT_MS,
          socketTimeout: TIMEOUT_MS,
          tls: { minVersion: "TLSv1.2" },
        },
        ...(c.ORBIT_SYSTEM_SMTP_USER && c.ORBIT_SYSTEM_SMTP_PASSWORD
          ? {
              auth: {
                user: c.ORBIT_SYSTEM_SMTP_USER,
                pass: c.ORBIT_SYSTEM_SMTP_PASSWORD,
              },
            }
          : {}),
      },
      outgoing,
    );
    return result.accepted.length
      ? { status: "sent" }
      : { status: "failed", code: "SMTP_REJECTED" };
  } catch (error) {
    return {
      status: "failed",
      code: error instanceof MailSendError ? error.code : "SMTP_ERROR",
    };
  }
}

type Locale = "en" | "de";
const product = () => loadConfig().ORBIT_SYSTEM_SMTP_FROM_NAME;

/** The texts of each system message, in English and German. */
export const systemMailTexts = {
  invitation(
    locale: Locale,
    v: { organization: string; link: string; expiresAt: Date },
  ): Omit<SystemMail, "to"> {
    const until = v.expiresAt.toISOString().slice(0, 10);
    return locale === "de"
      ? {
          subject: `Einladung zu ${v.organization} in ${product()}`,
          text: `Sie wurden zu ${v.organization} in ${product()} eingeladen.\n\nÜber diesen Link legen Sie Ihr Passwort fest und nehmen die Einladung an:\n${v.link}\n\nDer Link ist bis ${until} gültig und kann nur einmal verwendet werden. Wenn Sie keine Einladung erwartet haben, ignorieren Sie diese Nachricht.\n`,
        }
      : {
          subject: `Invitation to ${v.organization} on ${product()}`,
          text: `You have been invited to ${v.organization} on ${product()}.\n\nUse this link to set your password and accept the invitation:\n${v.link}\n\nThe link is valid until ${until} and works once. If you did not expect an invitation, ignore this message.\n`,
        };
  },
  passwordReset(locale: Locale, v: { link: string }): Omit<SystemMail, "to"> {
    return locale === "de"
      ? {
          subject: `Passwort für ${product()} zurücksetzen`,
          text: `Über diesen Link legen Sie ein neues Passwort fest:\n${v.link}\n\nDer Link ist eine Stunde gültig und kann nur einmal verwendet werden. Danach werden alle Sitzungen abgemeldet. Wenn Sie das nicht angefordert haben, ignorieren Sie diese Nachricht.\n`,
        }
      : {
          subject: `Reset your ${product()} password`,
          text: `Use this link to set a new password:\n${v.link}\n\nThe link is valid for one hour and works once. All sessions are signed out afterwards. If you did not ask for this, ignore this message.\n`,
        };
  },
  emailChange(locale: Locale, v: { link: string }): Omit<SystemMail, "to"> {
    return locale === "de"
      ? {
          subject: `Neue E-Mail-Adresse für ${product()} bestätigen`,
          text: `Bestätigen Sie diese Adresse als Ihre neue Anmeldeadresse:\n${v.link}\n\nDer Link ist eine Stunde gültig. Wenn Sie das nicht angefordert haben, ignorieren Sie diese Nachricht.\n`,
        }
      : {
          subject: `Confirm your new ${product()} e-mail address`,
          text: `Confirm this address as your new sign-in address:\n${v.link}\n\nThe link is valid for one hour. If you did not ask for this, ignore this message.\n`,
        };
  },
  emailChanged(locale: Locale): Omit<SystemMail, "to"> {
    return locale === "de"
      ? {
          subject: `Ihre ${product()}-Anmeldeadresse wurde geändert`,
          text: `Die Anmeldeadresse Ihres ${product()}-Kontos wurde geändert. Wenn Sie das nicht waren, wenden Sie sich sofort an Ihre Administration.\n`,
        }
      : {
          subject: `Your ${product()} sign-in address was changed`,
          text: `The sign-in address of your ${product()} account was changed. If this was not you, contact your administrator immediately.\n`,
        };
  },
};
