import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import SMTPConnection, {
  type SMTPConnectionOptions,
} from "nodemailer/lib/smtp-connection";
import MailComposer from "nodemailer/lib/mail-composer";
import { ImapFlow, type ImapFlowOptions } from "imapflow";

// SMTP and IMAP against the project's own mailbox (WP4.7, Q-16). Both sides
// sit behind small interfaces so tests replace them; the real ones use
// nodemailer and imapflow with TLS required and short timeouts. Both connect
// to the address the host check vetted (no second DNS lookup, so no DNS
// rebinding); TLS still verifies the certificate against the host name.
// Errors keep only codes, never the password, a server banner or content.

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
  /** The INBOX's UIDVALIDITY, its highest UID and its unread UIDs. */
  scan(): Promise<{ uidValidity: string; top: number; unseen: number[] }>;
  /** These INBOX messages; larger than `maxBytes` are reported as skipped. */
  fetchUids(
    uids: number[],
    maxBytes: number,
  ): Promise<{ messages: FetchedMessage[]; skipped: number[] }>;
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
  /**
   * Moves one INBOX message into `folder` (created when missing). The only
   * method that opens the INBOX read-write. "missing": the UID is gone;
   * "uid_validity_changed": the UID no longer names the same message.
   */
  move(
    state: { uidValidity: string; uid: number },
    folder: string,
  ): Promise<"moved" | "missing" | "uid_validity_changed">;
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
 * only: no IP literal, no local name, nothing private (SSRF). Returns the
 * vetted address the client must connect to.
 */
export async function assertPublicMailHost(host: string): Promise<string> {
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
  return addresses[0]!.address;
}

/** SMTP options pinned to the vetted address; TLS checks the host name. */
export function smtpOptions(
  account: EmailAccount,
  address: string,
): SMTPConnectionOptions {
  return {
    host: address,
    servername: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpTls === "implicit",
    requireTLS: account.smtpTls === "starttls",
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    tls: { minVersion: "TLSv1.2", servername: account.smtpHost },
  };
}

// A fetched message is at most 10 MB (inbound.ts); a server announcing
// more is refused instead of buffered (imapflow allows 1 GB by default).
const IMAP_MAX_LITERAL = 12 * 1024 * 1024;

/** IMAP options pinned to the vetted address; TLS checks the host name. */
export function imapOptions(
  account: EmailAccount,
  password: string,
  address: string,
): ImapFlowOptions {
  return {
    host: address,
    servername: account.imapHost,
    port: account.imapPort,
    secure: account.imapTls === "implicit",
    doSTARTTLS: account.imapTls === "starttls" ? true : undefined,
    auth: { user: account.username, pass: password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 3,
    tls: { minVersion: "TLSv1.2", servername: account.imapHost },
    maxLiteralSize: IMAP_MAX_LITERAL,
    maxResponseSize: IMAP_MAX_LITERAL + 1024 * 1024,
  };
}

export type SmtpSession = {
  options: SMTPConnectionOptions;
  auth?: { user: string; pass: string };
};

/** An SMTP error as codes only; see `classifySendError`. */
function smtpError(error: unknown, sending: boolean) {
  const e = error as { code?: string; command?: string; responseCode?: number };
  // Once the envelope is under way, a lost connection or a timeout may come
  // after the server took the message, and nodemailer then names no step
  // (or "CONN"). Without a server reply that is "maybe sent", never a retry.
  const command =
    sending &&
    e.responseCode === undefined &&
    (!e.command || e.command === "CONN")
      ? "DATA"
      : e.command;
  return new MailSendError(e.code ?? "SMTP_ERROR", command, e.responseCode);
}

/**
 * One SMTP session: connect, log in, and (with `mail`) hand the message
 * over. The step is tracked here because nodemailer reports a broken
 * connection as "CONN" whether or not the message was already out.
 */
export async function smtpSession(
  session: SmtpSession,
  mail?: OutgoingMail,
): Promise<SendResult> {
  const raw = mail
    ? await new MailComposer({
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
        .compile()
        .build()
    : null;
  const connection = new SMTPConnection(session.options);
  let sending = false;
  return new Promise<SendResult>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, result?: SendResult) => {
      if (settled) return;
      settled = true;
      connection.close();
      if (error) reject(smtpError(error, sending));
      else resolve(result!);
    };
    connection.on("error", (error) => finish(error));
    const handOver = () => {
      if (!mail || !raw) return finish(null, { accepted: [], rejected: [] });
      sending = true;
      connection.send(
        { from: mail.from.address, to: mail.to },
        raw,
        (error, info) =>
          error
            ? finish(error)
            : finish(null, {
                accepted: (info?.accepted ?? []).map(String),
                rejected: (info?.rejected ?? []).map(String),
              }),
      );
    };
    connection.connect((error) => {
      if (error) return finish(error);
      if (!session.auth) return handOver();
      connection.login(session.auth, (loginError) =>
        loginError ? finish(loginError) : handOver(),
      );
    });
  });
}

/** The sources of these messages; larger than `maxBytes` are skipped. */
async function fetchSources(
  c: ImapFlow,
  sizes: { uid: number; size: number }[],
  maxBytes: number,
) {
  const skipped = sizes.filter((m) => m.size > maxBytes).map((m) => m.uid);
  const wanted = sizes.filter((m) => m.size <= maxBytes).map((m) => m.uid);
  const messages: FetchedMessage[] = [];
  if (wanted.length)
    for await (const m of c.fetch(
      wanted.join(","),
      { uid: true, source: true },
      { uid: true },
    ))
      if (m.source) messages.push({ uid: m.uid, source: m.source });
  messages.sort((a, b) => a.uid - b.uid);
  return { messages, skipped: skipped.sort((a, b) => a - b) };
}

const realFactories: MailFactories = {
  checkHost: async (host) => void (await assertPublicMailHost(host)),
  transport(account, password) {
    const session = async (mail?: OutgoingMail) =>
      smtpSession(
        {
          options: smtpOptions(
            account,
            await assertPublicMailHost(account.smtpHost),
          ),
          auth: { user: account.username, pass: password },
        },
        mail,
      );
    return {
      verify: async () => void (await session()),
      send: (mail) => session(mail),
      close: () => undefined,
    };
  },
  mailbox(account, password) {
    const session = async <T>(work: (c: ImapFlow) => Promise<T>) => {
      const address = await assertPublicMailHost(account.imapHost);
      const c = new ImapFlow(imapOptions(account, password, address));
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
      scan: () =>
        session(async (c) => {
          const box = await c.mailboxOpen("INBOX", { readOnly: true });
          const unseen = await c.search({ seen: false }, { uid: true });
          return {
            uidValidity: String(box.uidValidity),
            top: Math.max(0, Number(box.uidNext) - 1),
            unseen: (unseen || []).sort((a, b) => a - b),
          };
        }),
      fetchUids: (uids, maxBytes) =>
        session(async (c) => {
          await c.mailboxOpen("INBOX", { readOnly: true });
          const sizes: { uid: number; size: number }[] = [];
          for await (const m of c.fetch(
            uids.join(","),
            { uid: true, size: true },
            { uid: true },
          ))
            sizes.push({ uid: m.uid, size: m.size ?? 0 });
          return fetchSources(c, sizes, maxBytes);
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
          return {
            uidValidity,
            ...(await fetchSources(c, batch, limits.maxBytes)),
          };
        }),
      move: (state, folder) =>
        session(async (c) => {
          const box = await c.mailboxOpen("INBOX");
          if (String(box.uidValidity) !== state.uidValidity)
            return "uid_validity_changed" as const;
          const found = await c.search(
            { uid: String(state.uid) },
            { uid: true },
          );
          if (!found || !found.length) return "missing" as const;
          // An existing folder makes the create fail; the move then decides.
          await c.mailboxCreate(folder).catch(() => undefined);
          const moved = await c.messageMove(String(state.uid), folder, {
            uid: true,
          });
          return moved ? ("moved" as const) : ("missing" as const);
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
