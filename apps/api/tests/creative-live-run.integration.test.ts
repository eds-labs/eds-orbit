import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import { priceCatalog } from "../../../packages/ai/src/catalog.ts";
import type { generateImage, respond } from "../../../packages/ai/src/index.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import {
  applyLiveEnvironment,
  assertLocalDatabase,
  BRAND_STOP_MICROS,
  IMAGE_MODEL,
  liveSettings,
  REVIEW_MODEL,
  runCreativeLive,
  SCRIPT_CAP_MICROS,
} from "../../../scripts/creative-live-run.ts";

// The wiring of scripts/creative-live-run.ts --pay (plan Task 22) with fake
// providers: nothing here may reach a real one.
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImage: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImageWithReferences: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe("creative live run guards", () => {
  it("refuses a database that is not on this machine", () => {
    expect(() =>
      assertLocalDatabase("DATABASE_URL", "postgresql://u:p@db.example.com/x"),
    ).toThrow(/^REFUSED/);
    expect(() =>
      assertLocalDatabase("DATABASE_URL", "postgresql://u:p@127.0.0.1:55432/x"),
    ).not.toThrow();
  });

  it("sets no key and turns every central AI layer off", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "launch-key",
      OPENAI_IMAGE_API_KEY: "image-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      ORBIT_CONNECTIONS: "true",
      ORBIT_CONNECTIONS_CUTOVER: "postiz",
    };
    applyLiveEnvironment(env, liveSettings(priceCatalog));
    expect(
      Object.keys(env).filter((k) => /^(OPENAI|ANTHROPIC)_.*KEY/.test(k)),
    ).toEqual([]);
    expect(env).toMatchObject({
      OPENAI_IMAGE_MAX_COST_MICROS: "250000",
      ORBIT_AI_CATALOG: "false",
      ORBIT_AI_ORG_BUDGET: "false",
      ORBIT_CONNECTIONS: "false",
      ORBIT_SPEND_POLICY_SOURCE: "platform",
    });
    expect(env.ORBIT_CONNECTIONS_CUTOVER).toBeUndefined();
  });
});

describe.skipIf(!enabled)("creative live run --pay with fake providers", () => {
  const saved = { ...process.env };
  const key = `sk-fake-${randomBytes(12).toString("hex")}`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const name of Object.keys(process.env))
      if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });
  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await closeDatabase();
  });

  /** Fake providers: good fixture art per brand and a passing review at `reviewMicros`. */
  function providers(reviewMicros = 10_000) {
    const brands = ["lumora", "kestrel"] as const;
    let images = 0;
    const generate = vi.fn(
      async (request: Parameters<typeof generateImage>[0]) => {
        const [width, height] = request.size.split("x").map(Number);
        const name = brands[images++]!;
        return {
          bytes: (await fixtureArt("good", name, { width, height })).bytes,
          model: IMAGE_MODEL,
          size: request.size,
          quality: request.quality,
          background: request.background,
          usage: null,
        };
      },
    );
    const review = vi.fn(async (_request: Parameters<typeof respond>[0]) => ({
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                scores: {
                  subject: 4,
                  balance: 4,
                  legibility: 4,
                  brandFit: 4,
                  messageFit: 4,
                  channelFit: 4,
                  value: 4,
                },
                issues: [],
              }),
            },
          ],
        },
      ],
      usage: {
        model: REVIEW_MODEL,
        inputTokens: 3000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 400,
        reasoningTokens: 0,
        costMicros: reviewMicros,
      },
      responseId: "fake-response",
      truncated: false,
    }));
    return {
      generate: generate as unknown as typeof generateImage & typeof generate,
      respond: review as unknown as typeof respond & typeof review,
    };
  }

  const live = (fakes: ReturnType<typeof providers>, capMicros?: number) => {
    applyLiveEnvironment(process.env, liveSettings(priceCatalog), key);
    const outDir = mkdtempSync(join(tmpdir(), "creative-live-run-"));
    dirs.push(outDir);
    const lines: string[] = [];
    return runCreativeLive({
      pay: true,
      outDir,
      log: (line) => lines.push(line),
      providers: fakes,
      capMicros,
    }).then((result) => ({ result, lines, outDir }));
  };
  const residue = () =>
    authDb.workspace.count({
      where: { name: { startsWith: "Creative live run" } },
    });

  it("makes one image and one review per brand, under the cap, without showing the key", async () => {
    const fakes = providers();
    const { result, lines, outDir } = await live(fakes);
    expect(result.failed).toBe(false);
    expect(fakes.generate).toHaveBeenCalledTimes(2);
    expect(fakes.respond).toHaveBeenCalledTimes(2);
    // The environment key reached both providers (no saved configuration).
    for (const [request] of [
      ...fakes.generate.mock.calls,
      ...fakes.respond.mock.calls,
    ])
      expect(request.runtime!.apiKey === key).toBe(true);
    for (const [request] of fakes.respond.mock.calls)
      expect(request.route.model).toBe(REVIEW_MODEL);
    expect(result.brands.map((b) => b.brand)).toEqual(["lumora", "kestrel"]);
    for (const brand of result.brands) {
      expect(brand.statusPath).toEqual([
        "produced:needs_rights",
        "art_approved",
        "recomposed:composed",
        "reviewed:pass",
      ]);
      expect(brand.reservations).toEqual([
        expect.objectContaining({
          key: expect.stringMatching(/^image:[0-9a-f-]{36}$/),
          category: "image_generation",
          model: IMAGE_MODEL,
          state: "settled",
          settledMicros: 250_000,
        }),
        expect.objectContaining({
          key: expect.stringMatching(/^creative-review:/),
          category: "creative_review",
          model: REVIEW_MODEL,
          state: "settled",
          settledMicros: 10_000,
        }),
      ]);
      // The dry run's prompt function is what the image call received.
      expect(brand.image.sentPrompt).toBe(brand.image.providerPrompt);
      expect(brand.image.referenceImages).toBe(0);
      expect(brand.vision?.verdict).toBe("pass");
      expect(brand.creativeStatus).toBe("composed");
      expect(brand.files.map((f) => f.slice(outDir.length + 1))).toEqual([
        `${brand.brand}-art.png`,
        `${brand.brand}-landscape.png`,
      ]);
      for (const file of brand.files) expect(existsSync(file)).toBe(true);
    }
    expect(result.totalSpentMicros).toBe(2 * 260_000);
    expect(result.totalSpentMicros).toBeLessThanOrEqual(SCRIPT_CAP_MICROS);
    const written = readFileSync(join(outDir, "result.json"), "utf8");
    expect(JSON.parse(written).brands).toHaveLength(2);
    expect([...lines, written].some((text) => text.includes(key))).toBe(false);
    expect(await residue()).toBe(0);
  });

  it("refuses to start when the ceilings exceed the script cap", async () => {
    const fakes = providers();
    const { result } = await live(fakes, 600_000);
    expect(result.failed).toBe(true);
    expect(result.stoppedReason).toMatch(/^SCRIPT_COST_CAP/);
    expect(result.brands).toEqual([]);
    expect(fakes.generate).not.toHaveBeenCalled();
    expect(fakes.respond).not.toHaveBeenCalled();
  });

  it("skips the second brand when the first used more than its share", async () => {
    const fakes = providers(BRAND_STOP_MICROS);
    const { result } = await live(fakes);
    expect(result.failed).toBe(false);
    expect(result.stoppedReason).toMatch(/^lumora used USD/);
    expect(result.brands.map((b) => b.brand)).toEqual(["lumora"]);
    expect(fakes.generate).toHaveBeenCalledTimes(1);
    expect(fakes.respond).toHaveBeenCalledTimes(1);
    expect(await residue()).toBe(0);
  });
});
