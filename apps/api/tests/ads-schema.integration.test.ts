import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, type DbTx } from "../../../packages/db/src/index.ts";
import { createAdsProject } from "./support/ads-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

// The ads module's tables (ADR 0025, plan §5): database rules the services
// will rely on.
describe.skipIf(!enabled)("ads schema (ADR 0025)", () => {
  let p: Awaited<ReturnType<typeof createAdsProject>>;
  let other: Awaited<ReturnType<typeof createAdsProject>>;
  const ids = (q = p) => ({
    workspaceId: q.owner.workspaceId,
    projectId: q.owner.projectId,
  });
  const message = (work: Promise<unknown>) =>
    work.then(
      () => "resolved",
      (e: Error) => e.message,
    );
  const account = (tx: DbTx, q = p, data: Record<string, unknown> = {}) =>
    tx.adAccount.create({
      data: {
        id: randomUUID(),
        ...ids(q),
        provider: "meta",
        externalId: randomUUID(),
        name: "Orbit test account",
        currency: "EUR",
        timezone: "Europe/Berlin",
        connectionId: randomUUID(),
        createdBy: q.owner.userId,
        ...data,
      },
    });

  beforeAll(async () => {
    p = await createAdsProject();
    other = await createAdsProject({ name: "Synthetic ads B" });
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("refuses the same ad account twice in one project", async () => {
    const result = await message(
      p.run(async (tx) => {
        const first = await account(tx);
        return account(tx, p, { externalId: first.externalId });
      }),
    );
    expect(result).toMatch(/AdAccount_external_key|Unique constraint/);
  });

  it("refuses an unknown provider, status or capability", async () => {
    for (const [field, check] of [
      ["provider", "AdAccount_provider_check"],
      ["status", "AdAccount_status_check"],
      ["capability", "AdAccount_capability_check"],
    ] as const) {
      const result = await message(
        p.run((tx) => account(tx, p, { [field]: "nope" })),
      );
      expect(result).toMatch(new RegExp(check));
    }
  });

  it("refuses an ad account with version 0", async () => {
    const result = await message(p.run((tx) => account(tx, p, { version: 0 })));
    expect(result).toMatch(/AdAccount_version_check/);
  });

  it("refuses a negative spend cap", async () => {
    const result = await message(
      p.run((tx) => account(tx, p, { spendCapMicros: -1n })),
    );
    expect(result).toMatch(/AdAccount_spend_cap_check/);
  });

  it("refuses a currency that is not three capital letters", async () => {
    const result = await message(
      p.run((tx) => account(tx, p, { currency: "eur" })),
    );
    expect(result).toMatch(/AdAccount_currency_check/);
  });

  it("refuses a sync state for another project's account", async () => {
    const foreign = await other.run((tx) => account(tx, other));
    const result = await message(
      p.run((tx) =>
        tx.adSyncState.create({
          data: {
            ...ids(),
            accountId: foreign.id,
            stream: "structure",
            nextRunAt: new Date(),
          },
        }),
      ),
    );
    expect(result).toMatch(/AdSyncState_account_fkey|Foreign key constraint/);
  });

  it("refuses a lease token without an expiry", async () => {
    const result = await message(
      p.run(async (tx) => {
        const a = await account(tx);
        return tx.adSyncState.create({
          data: {
            ...ids(),
            accountId: a.id,
            stream: "health",
            nextRunAt: new Date(),
            leaseToken: randomUUID(),
          },
        });
      }),
    );
    expect(result).toMatch(/AdSyncState_lease_check/);
  });

  it("refuses an unknown stream and a malformed throttle bucket", async () => {
    const stream = await message(
      p.run(async (tx) => {
        const a = await account(tx);
        return tx.adSyncState.create({
          data: { ...ids(), accountId: a.id, stream: "nope", nextRunAt: new Date() },
        });
      }),
    );
    expect(stream).toMatch(/AdSyncState_stream_check/);
    const bucket = await message(
      p.run((tx) =>
        tx.adProviderThrottle.create({
          data: { ...ids(), scope: "meta", bucket: "Bad Bucket", windowStart: new Date() },
        }),
      ),
    );
    expect(bucket).toMatch(/AdProviderThrottle_bucket_check/);
  });

  it("refuses an OAuth state that expires before it was created", async () => {
    const result = await message(
      p.run((tx) =>
        tx.adOAuthState.create({
          data: {
            id: randomUUID(),
            ...ids(),
            stateHash: "a".repeat(64),
            provider: "meta",
            appConnectionId: randomUUID(),
            userId: p.owner.userId,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() - 60_000),
          },
        }),
      ),
    );
    expect(result).toMatch(/AdOAuthState_expiry_check/);
  });

  it("hides another project's ad accounts", async () => {
    const row = await p.run((tx) => account(tx));
    const seen = await other.run((tx) =>
      tx.adAccount.findMany({ where: { id: row.id } }),
    );
    expect(seen).toEqual([]);
  });

  it("keeps ad accounts when the business role tries to delete one", async () => {
    const result = await message(
      p.run(async (tx) => {
        const row = await account(tx);
        return tx.adAccount.delete({ where: { id: row.id } });
      }),
    );
    expect(result).toMatch(/permission denied/);
  });
});
