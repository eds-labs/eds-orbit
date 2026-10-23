import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  financeFxSync,
  rateFor,
  resetFxSyncThrottle,
  setFxFetchForTests,
  setManualRate,
} from "../src/modules/finance/fx.ts";
import { writeFinanceSettings } from "../src/modules/finance/settings.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const xml = readFileSync(
  new URL("./fixtures/finance/ecb-hist.xml", import.meta.url),
  "utf8",
);

/** Rate lookup and the daily ECB sync against the database; the network is stubbed. */
describe.skipIf(!enabled)("finance fx", () => {
  const users: string[] = [];
  const workspaces: string[] = [];
  const previousFlag = process.env.ORBIT_FINANCE;
  const run = <T>(s: Scope, fn: (tx: DbTx) => Promise<T>) =>
    scoped(s.workspaceId, s.projectId, fn);
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "succeeded";
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };

  const newProject = async (moduleEnabled = true): Promise<Scope> => {
    const userId = randomUUID();
    await authDb.user.create({
      data: { id: userId, name: "Synthetic fx user", email: `${userId}@example.invalid` },
    });
    users.push(userId);
    const workspace = await authDb.workspace.create({
      data: { name: "Synthetic fx workspace", members: { create: { userId, role: "owner" } } },
    });
    workspaces.push(workspace.id);
    const project = await authDb.project.create({
      data: { workspaceId: workspace.id, name: "Synthetic fx project" },
    });
    const s: Scope = {
      workspaceId: workspace.id,
      projectId: project.id,
      userId,
      role: "owner",
    };
    if (moduleEnabled)
      await run(s, (tx) =>
        tx.projectModule.create({
          data: {
            workspaceId: s.workspaceId,
            projectId: s.projectId,
            moduleId: "finance",
            enabled: true,
            moduleVersion: "1.0.0",
          },
        }),
      );
    return s;
  };
  const feed = (body = xml, status = 200) => {
    let calls = 0;
    setFxFetchForTests(async () => {
      calls += 1;
      return new Response(body, { status });
    });
    return () => calls;
  };
  const count = (s: Scope) =>
    run(s, (tx) => tx.financeFxRate.count({ where: { projectId: s.projectId } }));

  beforeAll(() => {
    process.env.ORBIT_FINANCE = "true";
  });
  afterEach(() => {
    setFxFetchForTests(null);
    resetFxSyncThrottle();
  });
  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.ORBIT_FINANCE;
    else process.env.ORBIT_FINANCE = previousFlag;
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await closeDatabase();
  });

  it("sync stores rates from a stubbed fetch and survives a 500", async () => {
    const s = await newProject();
    feed("oops", 500);
    expect((await financeFxSync.run(s))?.status).toBe("fx failed");
    expect(await count(s)).toBe(0);

    resetFxSyncThrottle();
    const calls = feed();
    const first = await financeFxSync.run(s);
    expect(first?.status).toBe("fx rates=9");
    expect(await count(s)).toBe(9);
    // Throttled to once a day.
    await financeFxSync.run(s);
    expect(calls()).toBe(1);
    // Re-running after the throttle changes nothing.
    resetFxSyncThrottle();
    await run(s, (tx) =>
      tx.financeFxRate.updateMany({
        where: { projectId: s.projectId },
        data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
      }),
    );
    expect((await financeFxSync.run(s))?.status).toBe("fx rates=0");
    expect(await count(s)).toBe(9);
  });

  it("skips projects without finance or with a manual fx source", async () => {
    const off = await newProject(false);
    const calls = feed();
    expect((await financeFxSync.run(off))?.status).toBe("idle");
    const manual = await newProject();
    await run(manual, async (tx) => writeFinanceSettings(tx, manual, 1, { fxSource: "manual" }));
    expect((await financeFxSync.run(manual))?.status).toBe("idle");
    expect(calls()).toBe(0);
  });

  describe("lookup", () => {
    let s: Scope;
    beforeAll(async () => {
      s = await newProject();
      feed();
      await financeFxSync.run(s);
      setFxFetchForTests(null);
    });
    const rate = (from: string, to: string, date: string) =>
      run(s, (tx) => rateFor(tx, s, from, to, date));

    it("uses Friday's rate on Sunday", async () => {
      // 2026-10-25 is a Sunday; the stored days are Thu 22, Fri 23 and Mon 26.
      const result = await rate("EUR", "USD", "2026-10-25");
      expect(result).toEqual({ rate: "1.0853", rateDate: "2026-10-23", source: "ecb" });
      expect((await rate("USD", "EUR", "2026-10-26")).rateDate).toBe("2026-10-26");
    });

    it("fails with FX_RATE_MISSING after 7 days without a rate", async () => {
      expect(await failure(rate("EUR", "USD", "2026-11-03"))).toBe("FX_RATE_MISSING");
      expect((await rate("EUR", "USD", "2026-11-02")).rateDate).toBe("2026-10-26");
      expect(await failure(rate("EUR", "USD", "2026-10-15"))).toBe("FX_RATE_MISSING");
    });

    it("fails with FX_RATE_MISSING for a date after the newest rate when the gap exceeds 7 days", async () => {
      expect(await failure(rate("USD", "GBP", "2026-12-01"))).toBe("FX_RATE_MISSING");
    });

    it("USDC→EUR goes through the USD peg", async () => {
      await run(s, (tx) =>
        writeFinanceSettings(tx, s, 1, { usdcPeg: "1.000000" }),
      );
      expect(await rate("USDC", "EUR", "2026-10-23")).toEqual({
        rate: "0.921404220031",
        rateDate: "2026-10-23",
        source: "ecb",
      });
      expect(await rate("USDC", "USD", "2026-10-23")).toEqual({
        rate: "1",
        rateDate: "2026-10-23",
        source: "peg",
      });
      expect((await rate("USD", "USD", "2026-10-23")).source).toBe("identity");
    });

    it("combines two currencies with the older date and prefers manual rates", async () => {
      await run(s, (tx) =>
        setManualRate(tx, s, { date: "2026-10-23", currency: "USD", perEur: "1.1" }),
      );
      const result = await rate("USD", "GBP", "2026-10-23");
      expect(result.source).toBe("manual");
      expect(result.rate).toBe("0.761363636364");
      expect(
        await failure(
          run(s, (tx) =>
            setManualRate(tx, s, { date: "2026-10-23", currency: "USD", perEur: "0" }),
          ),
        ),
      ).toBe("RATE_INVALID");
      const override = { rate: "2", rateDate: "2026-01-01", source: "document" } as const;
      expect(await run(s, (tx) => rateFor(tx, s, "USD", "EUR", "2026-10-23", override))).toEqual(override);
    });
  });
});
