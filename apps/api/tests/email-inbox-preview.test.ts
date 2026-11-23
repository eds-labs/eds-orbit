import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailFactories,
  type EmailAccount,
} from "../src/platform/email/transport.ts";

const client = vi.hoisted(() => ({
  connect: vi.fn(),
  logout: vi.fn(),
  status: vi.fn(),
  mailboxOpen: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor() {
      return client;
    }
  },
}));

const account: EmailAccount = {
  smtpHost: "smtp.example.org",
  smtpPort: 465,
  smtpTls: "implicit",
  imapHost: "imap.example.org",
  imapPort: 993,
  imapTls: "implicit",
  username: "synthetic@example.org",
  fromAddress: "synthetic@example.org",
};

beforeEach(() => {
  vi.resetAllMocks();
  client.connect.mockResolvedValue(undefined);
  client.logout.mockResolvedValue(undefined);
});

describe("IMAP inbox preview", () => {
  it("reads a count without opening the mailbox or fetching messages", async () => {
    client.status.mockResolvedValue({ unseen: 5 });
    const reader = mailFactories().mailbox(account, "synthetic");
    await expect(reader.inboxUnread!()).resolves.toBe(5);
    expect(client.status).toHaveBeenCalledWith("INBOX", { unseen: true });
    expect(client.mailboxOpen).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("uses STATUS and a bounded, read-only envelope fetch", async () => {
    client.status.mockResolvedValue({ unseen: 16 });
    client.mailboxOpen.mockResolvedValue({ exists: 50_000 });
    client.fetch.mockImplementation(async function* () {
      for (let uid = 96; uid <= 100; uid++) {
        yield {
          uid,
          envelope: {
            from: [{ name: "Synthetic\nSender" }],
            subject: "x".repeat(300),
          },
          flags: new Set(uid === 99 ? [] : ["\\Seen"]),
          internalDate: new Date("2026-11-23T09:00:00.000Z"),
        };
      }
    });

    const response = await mailFactories().mailbox(account, "synthetic")
      .inboxPreview!();
    expect(client.status).toHaveBeenCalledWith("INBOX", { unseen: true });
    expect(client.mailboxOpen).toHaveBeenCalledWith("INBOX", {
      readOnly: true,
    });
    expect(client.fetch).toHaveBeenCalledWith("49996:50000", {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
    });
    expect(response.unread).toBe(16);
    expect(response.messages.map(({ uid }) => uid)).toEqual([
      100, 99, 98, 97, 96,
    ]);
    expect(response.messages[1]).toEqual({
      uid: 99,
      sender: "Synthetic Sender",
      subject: "x".repeat(240),
      receivedAt: "2026-11-23T09:00:00.000Z",
      unread: true,
    });
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("does not fetch an empty mailbox or report a missing count as zero", async () => {
    client.status
      .mockResolvedValueOnce({ unseen: 0 })
      .mockResolvedValueOnce(false);
    client.mailboxOpen.mockResolvedValue({ exists: 0 });
    const reader = mailFactories().mailbox(account, "synthetic");
    await expect(reader.inboxPreview!()).resolves.toEqual({
      unread: 0,
      messages: [],
    });
    expect(client.fetch).not.toHaveBeenCalled();
    await expect(reader.inboxPreview!()).rejects.toThrow("IMAP_ERROR");
    expect(client.logout).toHaveBeenCalledTimes(2);
  });
});
