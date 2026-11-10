import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  assistantCapMicros,
  assistantCapText,
  budgetFields,
} from "./ai-budget-ui";
import {
  MemberAssistantSwitch,
  setMemberAssistant,
} from "./organization-manager";

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ userId: "u2", enabled: false }), {
        status: 200,
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const t = {
  monthly: "Monthly",
  assistantField: "Assistant cap",
  assistantHint: "hint",
  assistantNone: "none: no paid assistant turns",
  perMonth: "a month",
  capField: (p: string) => `Cap ${p}`,
  creditField: (p: string) => `Credit ${p}`,
  creditHint: "credit hint",
} as unknown as Parameters<typeof budgetFields>[0];

describe("the personal assistant's cap per member (WP3.1)", () => {
  it("adds the cap field in USD after the monthly budget", () => {
    const fields = budgetFields(
      t,
      {
        budget: {
          monthlyMicros: 50_000_000,
          assistantPerUserMonthlyMicros: 2_500_000,
          providerCaps: {},
          credits: {},
          version: 1,
        },
      },
      {},
      {},
    );
    expect(fields.map((f) => f.name).slice(0, 2)).toEqual([
      "monthly",
      "assistant",
    ]);
    expect(fields[1]).toMatchObject({
      label: "Assistant cap",
      type: "number",
      value: "2.5",
    });
    expect(budgetFields(t, { budget: null }, {}, {})[1]!.value).toBe("");
  });

  it("stores dollars as micros and an empty field as null (no paid turns)", () => {
    expect(assistantCapMicros({ assistant: "5" })).toBe(5_000_000);
    expect(assistantCapMicros({ assistant: "0.25" })).toBe(250_000);
    expect(assistantCapMicros({ assistant: "" })).toBeNull();
    expect(assistantCapMicros({})).toBeNull();
  });

  it("shows the cap or that there are no paid assistant turns", () => {
    expect(assistantCapText(null, t as never)).toBe(
      "none: no paid assistant turns",
    );
    expect(assistantCapText(undefined, t as never)).toBe(
      "none: no paid assistant turns",
    );
    expect(assistantCapText(5_000_000, t as never)).toBe("$5.00 a month");
  });
});

describe("the member switch Assistant allowed (WP3.1)", () => {
  it("renders a labelled switch with its state", () => {
    const on = renderToStaticMarkup(
      <MemberAssistantSwitch
        name="Kim"
        enabled
        disabled={false}
        locale="de"
        onChange={() => {}}
      />,
    );
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-label="Assistent erlaubt für Kim"');
    expect(on).toContain('checked=""');
    const off = renderToStaticMarkup(
      <MemberAssistantSwitch
        name="Kim"
        enabled={false}
        disabled
        locale="en"
        onChange={() => {}}
      />,
    );
    expect(off).toContain('aria-label="Assistant allowed for Kim"');
    expect(off).not.toContain('checked=""');
    expect(off).toContain('disabled=""');
  });

  it("puts the member's switch", async () => {
    await setMemberAssistant("/organizations/w1", "u2", false);
    expect(calls).toEqual([
      {
        url: "/api/organizations/w1/members/u2/assistant",
        method: "PUT",
        body: { enabled: false },
      },
    ]);
  });
});
