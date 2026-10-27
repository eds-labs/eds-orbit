import { zodTextFormat } from "openai/helpers/zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StrategyCreative } from "../../creative/brief.ts";
import { outputIssues } from "./runner.ts";
import {
  CREATIVE_BRIEF_LIMITS,
  STRATEGY_TEXT_LIMITS,
  strategyOutput,
  strategySpecialist,
  strategySpecialistFor,
} from "./strategy.ts";

// The configuration the API needs to start: the specialist reads the Creative Studio flag when it is used.
const REQUIRED = {
  DATABASE_URL: "postgresql://a@b/c",
  AUTH_DATABASE_URL: "postgresql://a@b/c",
  REDIS_URL: "redis://redis:6379",
  AUTH_SECRET: "x".repeat(32),
  ORBIT_SETUP_TOKEN: "y".repeat(20),
  CREDENTIAL_KEY: "0".repeat(64),
};
beforeEach(() => {
  for (const [name, value] of Object.entries(REQUIRED))
    vi.stubEnv(name, process.env[name] ?? value);
  // The flag's default is off.
  vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
});
afterEach(() => vi.unstubAllEnvs());

const brief = (overrides: Record<string, unknown> = {}) => ({
  channel: "x",
  slotAt: "2026-10-13T08:00:00.000Z",
  topic: "Beta access",
  angle: "Lead with what traders can do on day one.",
  factKeys: ["url.beta_registration"],
  cta: "Create your beta account",
  imageIdea: null,
  notARepeatBecause: "No recent post covered the first day.",
  creative: null,
  ...overrides,
});

const creative = (overrides: Record<string, unknown> = {}) => ({
  keyMessage: "One calm view of the whole week",
  imageKind: "scene",
  motif: "A planner with a coffee cup on a tidy wooden desk",
  setting: "Bright home office, soft morning light by the window",
  template: "lifestyle",
  mood: "calm and focused",
  ...overrides,
});

/** What `finalize` stores: the kept briefs and what it dropped. */
type Finalized = { briefs: any[]; dropped: unknown[]; uncovered: unknown[] };
const finalize = (
  ...args: Parameters<NonNullable<typeof strategySpecialist.finalize>>
) => strategySpecialist.finalize!(...args) as Finalized;

/** The JSON schema the model is held to (strict: nullable fields stay required). */
const jsonSchema = (schema: Parameters<typeof zodTextFormat>[0]) =>
  zodTextFormat(schema, "orbit_agent_output").schema as any;

describe("strategy output", () => {
  it("accepts an angle that plans a 600–900 character post", () => {
    // Production uLiquid, 2026-10-13: with the post format in the
    // assignment, the strategy answer failed its schema (AGENT_OUTPUT_INVALID).
    const angle = "a".repeat(1000);
    expect(
      strategyOutput.safeParse({ briefs: [brief({ angle })] }).success,
    ).toBe(true);
  });

  it("tells the model every text limit it is checked against", () => {
    for (const [field, max] of Object.entries(STRATEGY_TEXT_LIMITS))
      expect(strategySpecialist.instructions).toContain(
        `${field} at most ${max}`,
      );
  });

  it("refuses an empty or over-long text", () => {
    expect(
      strategyOutput.safeParse({
        briefs: [brief({ angle: "a".repeat(STRATEGY_TEXT_LIMITS.angle + 1) })],
      }).success,
    ).toBe(false);
    expect(
      strategyOutput.safeParse({ briefs: [brief({ topic: "" })] }).success,
    ).toBe(false);
  });
});

describe("output issues", () => {
  it("names the failing field and its length, never its text", () => {
    const answer = JSON.stringify({
      briefs: [brief({ angle: "secret plan ".repeat(200) })],
    });
    const issues = outputIssues(answer, strategyOutput);
    expect(issues).toBe("briefs.0.angle:custom(2400)");
    expect(issues).not.toContain("secret");
  });

  it("tells an empty or non-JSON answer apart", () => {
    expect(outputIssues("", strategyOutput)).toBe("empty");
    expect(outputIssues("Here is the plan", strategyOutput)).toBe("not_json");
    // Production uLiquid, 2026-10-14: the research answer failed as not JSON.
    expect(outputIssues('{"findings":[{"lead":"cut', strategyOutput)).toBe(
      "truncated_json",
    );
  });
});

describe("creative brief", () => {
  it("accepts creative null and a valid creative", () => {
    const parse = (value: unknown) =>
      strategyOutput.safeParse({ briefs: [brief({ creative: value })] });
    expect(parse(null).success).toBe(true);
    expect(parse(creative()).success).toBe(true);
    // The strict schema has no optional fields: the key is always there.
    const { creative: _omitted, ...without } = brief();
    expect(strategyOutput.safeParse({ briefs: [without] }).success).toBe(false);
  });

  it("refuses a creative with an empty or unknown part", () => {
    for (const bad of [
      creative({ keyMessage: "" }),
      creative({ mood: "" }),
      creative({ template: "poster" }),
      creative({ imageKind: "video" }),
      { ...creative(), extra: true },
    ])
      expect(
        strategyOutput.safeParse({ briefs: [brief({ creative: bad })] })
          .success,
      ).toBe(false);
  });

  it("checks every creative text against its limit, naming the field", () => {
    for (const [field, max] of Object.entries(CREATIVE_BRIEF_LIMITS)) {
      const at = (length: number) => ({
        briefs: [
          brief({ creative: creative({ [field]: "m".repeat(length) }) }),
        ],
      });
      expect(strategyOutput.safeParse(at(max)).success).toBe(true);
      expect(strategyOutput.safeParse(at(max + 1)).success).toBe(false);
    }
    const answer = JSON.stringify({
      briefs: [
        brief({ creative: creative({ motif: "secret scene ".repeat(40) }) }),
      ],
    });
    const issues = outputIssues(answer, strategyOutput);
    expect(issues).toBe("briefs.0.creative.motif:custom(520)");
    expect(issues).not.toContain("secret");
  });

  it("lists creative as a nullable, required property of the JSON schema", () => {
    const item = jsonSchema(strategyOutput).properties.briefs.items;
    expect(item.required).toContain("creative");
    const variants = item.properties.creative.anyOf as Array<{
      type: string;
      properties?: Record<string, unknown>;
      required?: string[];
    }>;
    expect(variants.map((variant) => variant.type).sort()).toEqual([
      "null",
      "object",
    ]);
    const object = variants.find((variant) => variant.type === "object")!;
    expect(Object.keys(object.properties!).sort()).toEqual([
      "imageKind",
      "keyMessage",
      "mood",
      "motif",
      "setting",
      "template",
    ]);
    expect(object.required!.sort()).toEqual(
      Object.keys(object.properties!).sort(),
    );
  });

  it("fits the proposal the creative brief resolver takes", () => {
    const parsed = strategyOutput.parse({
      briefs: [brief({ creative: creative() })],
    });
    const proposal: StrategyCreative | null = parsed.briefs[0]!.creative;
    expect(proposal?.template).toBe("lifestyle");
  });

  describe("finalize", () => {
    const slot = { channel: "x", at: "2026-10-13T08:00:00.000Z" };
    const run = (creativeValue: unknown, creativeTemplates?: string[] | null) =>
      finalize({ briefs: [brief({ creative: creativeValue })] }, new Set(), {
        slots: [slot],
        usableKeys: ["url.beta_registration"],
        members: null,
        creativeTemplates,
      });

    it("replaces a template outside the assignment's with its first allowed one", () => {
      const result = run(creative({ template: "lifestyle" }), [
        "announcement",
        "tips",
      ]);
      expect(result.dropped).toEqual([]);
      expect(result.briefs).toHaveLength(1);
      expect(result.briefs[0].creative).toEqual(
        creative({ template: "announcement" }),
      );
    });

    it("keeps an allowed template, a missing list and a null creative", () => {
      expect(
        run(creative({ template: "tips" }), ["announcement", "tips"]).briefs[0]
          .creative.template,
      ).toBe("tips");
      for (const templates of [undefined, null, []])
        expect(
          run(creative({ template: "lifestyle" }), templates).briefs[0].creative
            .template,
        ).toBe("lifestyle");
      const nothing = run(null, ["announcement"]);
      expect(nothing.briefs).toHaveLength(1);
      expect(nothing.briefs[0].creative).toBeNull();
    });
  });

  // A creative task: its assignment carries a creative, which the runner
  // passes only while the switch is on and the project opted in (R65).
  const creativeTask = { assignment: { creative: { artPer: "post" } } };

  describe("with the Creative Studio on", () => {
    it("tells the model how to plan the image, and the limits it is checked against", () => {
      vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
      const strategy = strategySpecialistFor(creativeTask);
      expect(strategy.instructions).toContain(
        "If assignment.creative is set, also give each brief creative: keyMessage (the one message of the post's image), imageKind (scene for people and everyday situations, product when the post shows a feature through the product's own screenshots, graphic for typographic tips or announcements, combined for a real situation with the product's screenshot), motif (the main subject, concrete and visual), setting (place, light, time of day), template (one of assignment.creative.templates) and mood; otherwise creative is null. A motif never contains text, logos, interfaces or real persons.",
      );
      for (const [field, max] of Object.entries(CREATIVE_BRIEF_LIMITS))
        expect(strategy.instructions).toContain(`${field} at most ${max}`);
      expect(strategy.outputSchema).toBe(strategyOutput);
    });

    // R65: a task without a creative keeps the prompt and schema from before.
    it("keeps the plain prompt and schema for a task without a creative", () => {
      vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
      for (const input of [{}, { assignment: {} }, null])
        expect(strategySpecialistFor(input)).toBe(strategySpecialist);
      expect(strategySpecialist.instructions).not.toMatch(/creative/i);
    });
  });

  // CS-D6: with the flag off, the prompt and the answer's schema stay as they were.
  describe("with the Creative Studio off", () => {
    it("keeps the prompt and the answer's schema as before", () => {
      vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
      // Even a task that carries a creative gets the plain strategy.
      expect(strategySpecialistFor(creativeTask)).toBe(strategySpecialist);
      expect(strategySpecialist.instructions).not.toMatch(/creative/i);
      const schema = strategySpecialist.outputSchema;
      const { creative: _omitted, ...plain } = brief();
      expect(schema.safeParse({ briefs: [plain] }).success).toBe(true);
      expect(schema.safeParse({ briefs: [brief()] }).success).toBe(false);
      const item = jsonSchema(schema).properties.briefs.items;
      expect(item.required).not.toContain("creative");
      expect(Object.keys(item.properties)).not.toContain("creative");
    });

    it("stores briefs without a creative key", () => {
      vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
      const { creative: _omitted, ...plain } = brief();
      const result = finalize({ briefs: [plain] }, new Set(), {
        slots: [{ channel: "x", at: "2026-10-13T08:00:00.000Z" }],
        usableKeys: ["url.beta_registration"],
        members: null,
      });
      expect(result.briefs).toEqual([plain]);
      expect(Object.keys(result.briefs[0])).not.toContain("creative");
    });
  });
});
