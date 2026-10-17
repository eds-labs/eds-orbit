import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

// SMTP and IMAP against the project's own mailbox (WP4.7, Q-16). Both sides
// sit behind small interfaces so tests replace them; the real ones use
// nodemailer and imapflow with TLS required and short timeouts. Errors keep
// only codes, never the password, a server banner or message content.

export type TlsMode = "implicit" | "starttls";

export type EmailAccount = {
  smtpHost: string;
  smtpPort: number;
  smtpTls: TlsMode;
  imapHost: string;
  imapPort: number;
  imapTls: TlsMode;
  username: string;
  fromAddress: string;
  fromName?: string;
};

export type OutgoingMail = {
  from: { address: string; name?: string };
  to: string[];
  subject: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
  inReplyTo?: string;
  references?: string[];
};

export type SendResult = { accepted: string[]; rejected: string[] };

/** A failed send with what is known about it; see `classifySendError`. */
export class MailSendError extends Error {
  constructor(
    readonly code: string,
    readonly command?: string,
    readonly responseCode?: number,
  ) {
    super(code);
  }
}

export interface MailTransport {
  verify(): Promise<void>;
  send(mail: OutgoingMail): Promise<SendResult>;
  close(): void;
}

export type FetchedMessage = { uid: number; source: Buffer };
export interface MailboxReader {
  verify(): Promise<void>;
  /**
   * INBOX messages after `lastUid` (all of them when the UIDVALIDITY
   * changed), at most `max`, each at most `maxBytes`; larger ones are
   * reported as skipped.
   */
  fetchNew(
    state: { uidValidity?: string; lastUid: number },
    limits: { max: number; maxBytes: number },
  ): Promise<{
    uidValidity: string;
    messages: FetchedMessage[];
    skipped: number[];
  }>;
}

export type MailFactories = {
  transport(account: EmailAccount, password: string): MailTransport;
  mailbox(account: EmailAccount, password: string): MailboxReader;
  /** Refuses a host that is not public; see `assertPublicMailHost`. */
  checkHost(host: string): Promise<void>;
};

const TIMEOUT_MS = 20_000;

/**
 * A mail host must be a public DNS name that resolves to public addresses
 * only: no IP literal, no local name, nothing private (SSRF).
 */
export async function assertPublicMailHost(host: string) {
  const name = host.trim().toLowerCase();
  if (
    !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
      name,
    ) ||
    /\.(local|localhost|internal|lan|home|test|invalid)$/.test(name)
  )
    throw new MailSendError("MAIL_HOST_INVALID");
  let addresses: { address: string }[];
  try {
    addresses = await lookup(name, { all: true });
  } catch {
    throw new MailSendError("MAIL_HOST_UNRESOLVED");
  }
  if (
    !addresses.length ||
    addresses.some((a) => ipaddr.process(a.address).range() !== "unicast")
  )
    throw new MailSendError("MAIL_HOST_NOT_PUBLIC");
}

const realFactories: MailFactories = {
  checkHost: assertPublicMailHost,
  transport(account, password) {
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpTls === "implicit",
      requireTLS: account.smtpTls === "starttls",
      auth: { user: account.username, pass: password },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      tls: { minVersion: "TLSv1.2" },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const wrap = (error: unknown): never => {
      const e = error as {
        code?: string;
        command?: string;
        responseCode?: number;
      };
      throw new MailSendError(
        e.code ?? "SMTP_ERROR",
        e.command,
        e.responseCode,
      );
    };
    return {
      async verify() {
        await assertPublicMailHost(account.smtpHost);
        await transporter.verify().catch(wrap);
      },
      async send(mail) {
        await assertPublicMailHost(account.smtpHost);
        const info = await transporter
          .sendMail({
            from: mail.from,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            messageId: mail.messageId,
            headers: mail.headers,
            inReplyTo: mail.inReplyTo,
            references: mail.references,
            disableFileAccess: true,
            disableUrlAccess: true,
          })
          .catch(wrap);
        return {
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
        };
      },
      close: () => transporter.close(),
    };
  },
  mailbox(account, password) {
    const client = () =>
      new ImapFlow({
        host: account.imapHost,
        port: account.imapPort,
        secure: account.imapTls === "implicit",
        doSTARTTLS: account.imapTls === "starttls" ? true : undefined,
        auth: { user: account.username, pass: password },
        logger: false,
        connectionTimeout: TIMEOUT_MS,
        greetingTimeout: TIMEOUT_MS,
        socketTimeout: TIMEOUT_MS * 3,
        tls: { minVersion: "TLSv1.2" },
      });
    const session = async <T>(work: (c: ImapFlow) => Promise<T>) => {
      await assertPublicMailHost(account.imapHost);
      const c = client();
      try {
        await c.connect();
        return await work(c);
      } catch (error) {
        if (error instanceof MailSendError) throw error;
        throw new MailSendError(
          (error as { authenticationFailed?: boolean }).authenticationFailed
            ? "IMAP_AUTH"
            : "IMAP_ERROR",
        );
      } finally {
        await c.logout().catch(() => c.close());
      }
    };
    return {
      verify: () =>
        session(async (c) => {
          await c.mailboxOpen("INBOX", { readOnly: true });
        }),
      fetchNew: (state, limits) =>
        session(async (c) => {
          const box = await c.mailboxOpen("INBOX", { readOnly: true });
          const uidValidity = String(box.uidValidity);
          const from = uidValidity === state.uidValidity ? state.lastUid : 0;
          const sizes: { uid: number; size: number }[] = [];
          for await (const m of c.fetch(
            `${from + 1}:*`,
            { uid: true, size: true },
            { uid: true },
          ))
            // `n:*` also returns the last message when none is newer.
            if (m.uid > from) sizes.push({ uid: m.uid, size: m.size ?? 0 });
          sizes.sort((a, b) => a.uid - b.uid);
          const batch = sizes.slice(0, limits.max);
          const skipped = batch
            .filter((m) => m.size > limits.maxBytes)
            .map((m) => m.uid);
          const wanted = batch
            .filter((m) => m.size <= limits.maxBytes)
            .map((m) => m.uid);
          const messages: FetchedMessage[] = [];
          if (wanted.length)
            for await (const m of c.fetch(
              wanted.join(","),
              { uid: true, source: true },
              { uid: true },
            ))
              if (m.source) messages.push({ uid: m.uid, source: m.source });
          messages.sort((a, b) => a.uid - b.uid);
          return { uidValidity, messages, skipped };
        }),
    };
  },
};

let override: MailFactories | null = null;
/** Tests replace SMTP and IMAP; null restores the real clients. */
export function setMailFactoriesForTests(factories: MailFactories | null) {
  override = factories;
}
export const mailFactories = (): MailFactories => override ?? realFactories;

// Commands before the message is handed over: a failure there sent nothing.
const BEFORE_DATA = new Set([
  "CONN",
  "EHLO",
  "HELO",
  "LHLO",
  "STARTTLS",
  "AUTH PLAIN",
  "AUTH LOGIN",
  "AUTH CRAM-MD5",
  "AUTH XOAUTH2",
  "MAIL FROM",
  "RCPT TO",
]);
const NOT_SENT_CODES = new Set([
  "EAUTH",
  "EDNS",
  "EENVELOPE",
  "ETLS",
  "ECONNECTION",
  "MAIL_HOST_INVALID",
  "MAIL_HOST_UNRESOLVED",
  "MAIL_HOST_NOT_PUBLIC",
]);

/**
 * What a failed send means:
 * - `rejected`: the server refused for good (5xx); do not retry.
 * - `failed`: nothing was handed over, or a temporary 4xx; may be retried.
 * - `outcome_unknown`: the message may be out; never send it again.
 */
export function classifySendError(
  error: unknown,
): "rejected" | "failed" | "outcome_unknown" {
  if (!(error instanceof MailSendError)) return "outcome_unknown";
  if (error.responseCode !== undefined && error.responseCode >= 500)
    return "rejected";
  if (error.responseCode !== undefined && error.responseCode >= 400)
    return "failed";
  if (error.command && BEFORE_DATA.has(error.command.toUpperCase()))
    return "failed";
  if (!error.command && NOT_SENT_CODES.has(error.code)) return "failed";
  return "outcome_unknown";
}
