import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifySendError,
  imapOptions,
  MailSendError,
  smtpOptions,
  smtpSession,
  type EmailAccount,
  type OutgoingMail,
} from "../src/platform/email/transport.ts";

// The real SMTP client against a scripted local server (WP4.7 review): what
// nodemailer reports when the connection breaks at each step, and whether
// Orbit then retries (nothing left) or stops (the message may be out).

type AfterData = "accept" | "drop" | "silent" | "451" | "554";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A minimal SMTP server; `afterData` is its answer to the final dot. */
async function fakeSmtp(afterData: AfterData, rejectRcpt = false) {
  const received: string[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    socket.write("220 fake.example ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          if (afterData === "accept") socket.write("250 2.0.0 queued\r\n");
          else if (afterData === "drop") socket.destroy();
          else if (afterData === "451") socket.write("451 4.3.0 try later\r\n");
          else if (afterData === "554") socket.write("554 5.7.1 refused\r\n");
          // "silent": no answer at all, the client times out.
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl).toUpperCase();
        buffer = buffer.slice(nl + 2);
        if (line.startsWith("EHLO")) socket.write("250 fake.example\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO"))
          socket.write(
            rejectRcpt ? "550 5.1.1 no such user\r\n" : "250 ok\r\n",
          );
        else if (line === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("502 unknown\r\n");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, received };
}

const MAIL: OutgoingMail = {
  from: { address: "support@eds-labs.example", name: "EDS Support" },
  to: ["member@example.org"],
  subject: "Hello",
  text: "Body",
  messageId: "<orbit.00000000-0000-4000-8000-000000000000@eds-labs.example>",
  headers: { "X-Orbit-Message": "00000000-0000-4000-8000-000000000000" },
};

/** Sends as Orbit's transport did: nodemailer, errors wrapped to codes. */
async function sendViaNodemailer(port: number) {
  const transporter = nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    socketTimeout: 500,
  });
  try {
    await transporter.sendMail({ ...MAIL });
    return null;
  } catch (error) {
    const e = error as {
      code?: string;
      command?: string;
      responseCode?: number;
    };
    return new MailSendError(e.code ?? "SMTP_ERROR", e.command, e.responseCode);
  } finally {
    transporter.close();
  }
}

describe("SMTP outcomes with the real client", () => {
  it("nodemailer reports a connection lost after DATA as command CONN", async () => {
    const smtp = await fakeSmtp("drop");
    const error = await sendViaNodemailer(smtp.port);
    // The server has the whole message, yet the error names no DATA step.
    expect(smtp.received).toHaveLength(1);
    expect(error).toMatchObject({ code: "ECONNECTION", command: "CONN" });
  });

  it("never retries a message the server may have taken", async () => {
    for (const afterData of ["drop", "silent"] as const) {
      const smtp = await fakeSmtp(afterData);
      const error = await sendViaOrbit(smtp.port).catch((e: unknown) => e);
      expect(smtp.received).toHaveLength(1);
      expect(classifySendError(error)).toBe("outcome_unknown");
    }
  });

  it("retries what never reached the server and stops at a refusal", async () => {
    // Nobody listens: nothing was handed over, a retry is safe.
    const closed = await fakeSmtp("accept");
    await new Promise((r) => servers.pop()!.close(r));
    expect(
      classifySendError(
        await sendViaOrbit(closed.port).catch((e: unknown) => e),
      ),
    ).toBe("failed");
    // 4xx after the data: not taken, may be retried.
    const later = await fakeSmtp("451");
    expect(
      classifySendError(await sendViaOrbit(later.port).catch((e) => e)),
    ).toBe("failed");
    // 5xx after the data, or for the recipient: refused for good.
    const refused = await fakeSmtp("554");
    expect(
      classifySendError(await sendViaOrbit(refused.port).catch((e) => e)),
    ).toBe("rejected");
    const unknown = await fakeSmtp("accept", true);
    expect(
      classifySendError(await sendViaOrbit(unknown.port).catch((e) => e)),
    ).toBe("rejected");
    expect(unknown.received).toHaveLength(0);
  });

  it("sends a message the server takes, with single-line headers", async () => {
    const smtp = await fakeSmtp("accept");
    const result = await sendViaOrbit(smtp.port, {
      ...MAIL,
      // Threading ids come from inbound mail: line breaks must not survive.
      inReplyTo: "<a@example.org>\r\nBcc: x@evil.example",
      references: ["<b@example.org>\r\nBcc: y@evil.example"],
    });
    expect(result.accepted).toEqual(["member@example.org"]);
    const raw = smtp.received[0]!;
    expect(raw).toContain(`Message-ID: ${MAIL.messageId}`);
    expect(raw).toContain("X-Orbit-Message:");
    expect(raw).not.toMatch(/^Bcc:/im);
  });
});

describe("mail hosts are pinned to the vetted address", () => {
  const account: EmailAccount = {
    smtpHost: "smtp.mailbox.example.com",
    smtpPort: 465,
    smtpTls: "implicit",
    imapHost: "imap.mailbox.example.com",
    imapPort: 993,
    imapTls: "starttls",
    username: "support@eds-labs.example",
    fromAddress: "support@eds-labs.example",
  };
  it("connects to the address and checks the certificate for the name", () => {
    // A second lookup by the client could return another (private) address.
    expect(smtpOptions(account, "93.184.216.34")).toMatchObject({
      host: "93.184.216.34",
      servername: "smtp.mailbox.example.com",
      secure: true,
      tls: { minVersion: "TLSv1.2", servername: "smtp.mailbox.example.com" },
    });
    const imap = imapOptions(account, "pw", "2606:2800:220:1::1");
    expect(imap).toMatchObject({
      host: "2606:2800:220:1::1",
      servername: "imap.mailbox.example.com",
      secure: false,
      doSTARTTLS: true,
      tls: { servername: "imap.mailbox.example.com" },
    });
    // A hostile server cannot make the worker buffer a gigabyte.
    expect(imap.maxLiteralSize).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});

/** Sends through Orbit's SMTP session against the local server. */
function sendViaOrbit(port: number, mail: OutgoingMail = MAIL) {
  return smtpSession(
    {
      options: {
        host: "127.0.0.1",
        port,
        secure: false,
        ignoreTLS: true,
        socketTimeout: 500,
      },
    },
    mail,
  );
}
