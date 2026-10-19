import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { moreRunsLabel, RUNS_PAGE, RunStepList } from "./agent-runs";

const step = (name: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  type: "tool_call",
  name,
  model: null,
  status: "succeeded",
  errorCode: null,
  attempt: 1,
  startedAt: "2026-10-06T10:27:26.000Z",
  durationMs: 3,
  inputTokens: null,
  cachedTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  costMicros: null,
  ...extra,
});

describe("RunStepList", () => {
  it("shows each step with its tool, model, outcome and exact cost", () => {
    const html = renderToStaticMarkup(
      <RunStepList
        de
        steps={[
          step("responses.create", {
            type: "model_call",
            model: "gpt-6.1-sol",
            durationMs: 900,
            inputTokens: 9924,
            outputTokens: 213,
            costMicros: "11343",
          }),
          step("tool_search"),
          step("schedule_options", {
            status: "failed",
            errorCode: "CHANNEL_NOT_FOUND",
          }),
        ]}
      />,
    );
    expect(html).toContain("Modellaufruf");
    expect(html).toContain("gpt-6.1-sol");
    expect(html).toContain("9924 / 213");
    expect(html).toContain("$0.011343");
    expect(html).toContain("Tool");
    expect(html).toContain("tool_search");
    expect(html).toContain("CHANNEL_NOT_FOUND");
    expect(html.indexOf("responses.create")).toBeLessThan(
      html.indexOf("tool_search"),
    );
  });

  it("says so when a run recorded no steps", () => {
    expect(renderToStaticMarkup(<RunStepList de steps={[]} />)).toContain(
      "Keine Schritte aufgezeichnet",
    );
  });
});

// Production, 2026-10-19: the operations page listed every run of the API's
// page of 50 at once; now ten, with the rest and older pages on request.
describe("moreRunsLabel", () => {
  it("offers the loaded runs first, then the API's next page, else nothing", () => {
    expect(RUNS_PAGE).toBe(10);
    expect(moreRunsLabel(40, true, true)).toBe("40 weitere anzeigen");
    expect(moreRunsLabel(3, false, false)).toBe("Show 3 more");
    expect(moreRunsLabel(0, true, true)).toBe("Ältere Läufe laden");
    expect(moreRunsLabel(0, true, false)).toBe("Load older runs");
    expect(moreRunsLabel(0, false, true)).toBeNull();
  });
});
