import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  aiBudgetText,
  BudgetLevelBlocks,
  budgetPayload,
  originText,
  usageProjectRows,
  type BudgetLevels,
} from "./ai-budget-ui";

const levels = (over: Partial<BudgetLevels> = {}): BudgetLevels => ({
  organization: {
    state: "off",
    monthlyMicros: 200_000_000,
    spentMicros: 0,
    origin: { by: { id: "u1", name: "Mario" }, at: "2026-11-01T09:00:00.000Z" },
  },
  assistant: {
    available: true,
    state: "not_set",
    capMicros: null,
    perDayMicros: null,
    perAnswerMicros: null,
    usage: { spentMicros: 0, unknownMicros: 0, spaces: 2 },
    origin: null,
  },
  projects: [
    {
      projectId: "p1",
      name: "FamilyPlan",
      state: "active",
      source: "platform",
      monthlyBudgetMicros: 25_000_000,
      dailyBudgetMicros: 2_500_000,
      perRunBudgetMicros: 2_000_000,
      endAt: "2027-01-31T00:00:00.000Z",
      spentMicros: 1_200_000,
      origin: { by: { id: "u1", name: "Mario" }, at: "2026-11-08T10:00:00.000Z" },
    },
    {
      projectId: "p2",
      name: "uLiquid",
      state: "not_set",
      source: "none",
      monthlyBudgetMicros: null,
      dailyBudgetMicros: null,
      perRunBudgetMicros: null,
      endAt: null,
      spentMicros: 0,
      origin: null,
    },
  ],
  ...over,
});

describe("the organization's budget levels (WP2 B)", () => {
  it("anchors the assistant cap and states that project budgets never fund it", () => {
    const html = renderToStaticMarkup(
      <BudgetLevelBlocks levels={levels()} t={aiBudgetText("de")} locale="de" />,
    );
    expect(html).toContain('id="assistant-budget"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Projektbudgets gelten dafür nie");
    expect(html).toContain("nicht gesetzt: keine bezahlten Antworten");
    expect(html).toContain("über 2 persönliche Bereiche (eine Summe, nie pro Mitglied)");
  });

  it("lists each project's own limit, state and origin", () => {
    const html = renderToStaticMarkup(
      <BudgetLevelBlocks levels={levels()} t={aiBudgetText("en")} locale="en" />,
    );
    expect(html).toContain("FamilyPlan");
    expect(html).toContain("$25.00 a month · $2.50 a day · $2.00 per run");
    expect(html).toContain("Set by Mario on");
    expect(html).toContain("no spending authority");
    expect(html).toContain("$1.20 this month");
  });

  it("names who set the assistant cap only once there is one", () => {
    const origin = { by: { id: "u1", name: "Mario" }, at: "2026-11-10T09:00:00.000Z" };
    const assistant = (capMicros: number | null) =>
      renderToStaticMarkup(
        <BudgetLevelBlocks
          levels={levels({
            projects: [],
            assistant: { ...levels().assistant, capMicros, origin },
          })}
          t={aiBudgetText("de")}
          locale="de"
        />,
      );
    // The organization budget was saved by Mario, but the cap is unset.
    expect(assistant(null)).not.toContain("Festgelegt von");
    expect(assistant(0)).toContain("Festgelegt von Mario am");
    expect(assistant(5_000_000)).toContain("Festgelegt von Mario am");
  });

  it("derives the per-answer limit text from an active cap", () => {
    const html = renderToStaticMarkup(
      <BudgetLevelBlocks
        levels={levels({
          assistant: {
            available: false,
            state: "active",
            capMicros: 5_000_000,
            perDayMicros: 500_000,
            perAnswerMicros: 500_000,
            usage: { spentMicros: 300_000, unknownMicros: 0, spaces: 1 },
            origin: null,
          },
        })}
        t={aiBudgetText("en")}
        locale="en"
      />,
    );
    expect(html).toContain("$5.00 a month");
    expect(html).toContain("up to $0.50 per answer, $0.50 per day");
    expect(html).toContain("switched off on this installation");
  });

  it("says who set a limit, or only when", () => {
    const t = aiBudgetText("en");
    expect(originText(null, t, "en")).toBeNull();
    expect(
      originText({ by: null, at: "2026-11-01T09:00:00.000Z" }, t, "en"),
    ).toMatch(/^Set on /);
  });

  it("the off banner no longer claims the assistant cap is not applied", () => {
    expect(aiBudgetText("en").off).toContain("cap per member applies regardless");
    expect(aiBudgetText("de").off).toContain("gilt trotzdem");
  });
});

describe("usage by project", () => {
  it("adds the personal assistants as one row, never per member", () => {
    const rows = usageProjectRows(
      {
        periodStart: "2026-11-01T00:00:00.000Z",
        projects: [
          { projectId: "p1", name: "FamilyPlan", spentMicros: 100, unknownMicros: 0, count: 1 },
        ],
        assistants: { spentMicros: 300, unknownMicros: 50, count: 4, spaces: 3 },
        providers: [],
        models: [],
        tasks: [],
      },
      aiBudgetText("en"),
    );
    expect(rows.map((r) => r.key)).toEqual([
      "Personal assistants (3 members, one sum)",
      "FamilyPlan",
    ]);
    expect(rows[0]).toMatchObject({ spentMicros: 300, unknownMicros: 50 });
  });
});

describe("the budget form's payload (settings center phase 4, risk 8)", () => {
  // Characterization: `PUT …/ai/budget` replaces all four parts, so the form
  // must keep sending every one of them, empty ones included.
  it("sends every part the budget PUT replaces", () => {
    const values = { monthly: "", assistant: "", "cap-openai": "", "credit-openai": "" };
    expect(Object.keys(budgetPayload(values, {}, "2026-11-11T12:00:00.000Z")).sort()).toEqual([
      "assistantPerUserMonthlyMicros",
      "credits",
      "monthlyMicros",
      "providerCaps",
    ]);
  });
});
