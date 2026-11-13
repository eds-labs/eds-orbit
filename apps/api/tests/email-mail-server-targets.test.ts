import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

import { encrypt } from "../src/shared.ts";
import { mailServerTargets } from "../src/platform/email/shared-client.ts";

const KEY = "ab".repeat(32);
const connection = (overrides: Record<string, unknown> = {}) => ({
  smtpHost: "smtp.mailbox.example.com",
  smtpPort: 587,
  smtpTls: "starttls",
  imapHost: "imap.mailbox.example.com",
  imapPort: 993,
  imapTls: "implicit",
  username: "info@desk.example",
  fromAddress: "info@desk.example",
  encryptedCredential: encrypt("synthetic-password", KEY),
  ...overrides,
});

describe("mailServerTargets", () => {
  beforeEach(() => {
    process.env.CREDENTIAL_KEY = KEY;
    lookup.mockReset();
    lookup.mockImplementation(async (name: string) => [
      { address: name.startsWith("imap") ? "93.184.216.34" : "93.184.216.35" },
    ]);
  });

  it("returns the vetted address, the name for TLS and the mapped mode", async () => {
    expect(await mailServerTargets(connection())).toEqual({
      imap: {
        host: "93.184.216.34",
        tlsPeerName: "imap.mailbox.example.com",
        port: 993,
        tlsMode: "ssl",
        user: "info@desk.example",
        password: "synthetic-password",
      },
      smtp: {
        host: "93.184.216.35",
        tlsPeerName: "smtp.mailbox.example.com",
        port: 587,
        tlsMode: "tls",
        user: "info@desk.example",
        password: "synthetic-password",
      },
    });
  });

  it("refuses a host that resolves to a private address", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.5" }]);
    await expect(mailServerTargets(connection())).rejects.toMatchObject({
      code: "MAIL_HOST_NOT_PUBLIC",
    });
  });

  it("refuses an IP literal without a lookup", async () => {
    await expect(
      mailServerTargets(connection({ imapHost: "127.0.0.1" })),
    ).rejects.toMatchObject({ code: "MAIL_HOST_INVALID" });
  });

  it("maps an explicit none and refuses an unknown mode", async () => {
    const plain = await mailServerTargets(connection({ imapTls: "none" }));
    expect(plain.imap.tlsMode).toBe("none");
    await expect(
      mailServerTargets(connection({ imapTls: "ancient" })),
    ).rejects.toMatchObject({ code: "MAIL_TLS_INVALID" });
  });
});
