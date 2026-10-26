import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addCounts, redact, redactText } from "../src/platform/privacy/redact.ts";

type Case = {
  name: string;
  text: string;
  names?: string[];
  remove?: string[];
  keep?: string[];
  counts: Record<string, number>;
};
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/redaction-cases.json", import.meta.url), "utf8"),
) as { cases: Case[]; falsePositives: Case[] };

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

  it.each(fixtures.cases)("removes every fixture value: $name", (c) => {
    const { text, counts } = redact(c.text, { names: c.names });
    for (const value of c.remove ?? []) expect(text).not.toContain(value);
    for (const value of c.keep ?? []) expect(text).toContain(value);
    expect(counts).toEqual(c.counts);
  });

  it("documents its known false positives", () => {
    for (const c of fixtures.falsePositives) expect(redact(c.text).counts).toEqual(c.counts);
  });

  it("keeps wallets and transaction hashes in the standard profile only", () => {
    const text = "From 0x52908400098527886E0F7030069857D2E4169EE7 to bob@example.org";
    expect(redact(text, { profile: "standard" })).toEqual({
      text: "From 0x52908400098527886E0F7030069857D2E4169EE7 to [e-mail removed]",
      counts: { email: 1 },
    });
    expect(redact(text).counts).toEqual({ email: 1, wallet: 1 });
  });

  it("removes names in any case on word boundaries, never inside words or masks", () => {
    const { text, counts } = redact("ANNA wrote to anna; Annabel and Removed stay. Mail anna@example.org", {
      names: ["Anna Removed"],
    });
    expect(text).toBe("[name removed] wrote to [name removed]; Annabel and [name removed] stay. Mail [e-mail removed]");
    expect(counts).toEqual({ email: 1, name: 3 });
  });

  it("is deterministic and handles 100 KB quickly", () => {
    const block = fixtures.cases.map((c) => c.text).join("\n");
    const big = block.repeat(Math.ceil(100_000 / block.length)).slice(0, 100_000);
    const first = redact(big, { names: ["Anna Schmidt"] });
    const started = performance.now();
    const second = redact(big, { names: ["Anna Schmidt"] });
    const elapsed = performance.now() - started;
    expect(second).toEqual(first);
    // The plan's budget is 20 ms; the margin absorbs slow CI machines.
    expect(elapsed).toBeLessThan(100);
  });

  it("adds counts", () => {
    expect(addCounts({ email: 1 }, { email: 2, phone: 1 }, {})).toEqual({ email: 3, phone: 1 });
  });
});
