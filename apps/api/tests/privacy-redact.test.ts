import { describe, expect, it } from "vitest";
import { addCounts, redactText } from "../src/platform/privacy/redact.ts";

describe("redaction of outgoing text", () => {
  it("removes e-mails, phones, secrets, wallets and transaction hashes and counts them", () => {
    const input = [
      "Customer anna.schmidt@example.org called from +49 170 1234567.",
      "Token ghp_abcdefghijklmnopqrstuvwxyz123456 and api_key = 'supersecretvalue'.",
      "Wallet 0x52908400098527886E0F7030069857D2E4169EE7 sent tx 0x" + "a".repeat(64) + ".",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "Office 0170/1234567 or (030) 123 45 67; US 555-123-4567.",
      "Issue #1234 in version 2.10.3 on 2026-10-25 costs 1500000 micros.",
    ].join("\n");
    const { text, counts } = redactText(input);
    expect(counts).toEqual({ secret: 3, email: 1, phone: 4, wallet: 1, tx_hash: 1 });
    expect(text).not.toMatch(/anna\.schmidt|1234567|123 45 67|555-123|ghp_|supersecret|0x52908|aaaaaaaa|MIIEow/);
    expect(text).toContain("api_key = [secret removed]");
    // Ordinary numbers, versions and dates stay.
    expect(text).toContain("Issue #1234 in version 2.10.3 on 2026-10-25 costs 1500000 micros.");
  });

  it("adds counts", () => {
    expect(addCounts({ email: 1 }, { email: 2, phone: 1 }, {})).toEqual({ email: 3, phone: 1 });
  });
});
