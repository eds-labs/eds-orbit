import { describe, expect, it } from "vitest";
import { withGenerationProvenance } from "./content-provenance.ts";

describe("edited content provenance", () => {
  it("keeps the model, usage and job of the generated version", () => {
    const usage = {
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      costMicros: 3,
    };
    expect(
      withGenerationProvenance(
        { body: "old", model: "m", usage, jobId: "job-1" },
        { body: "new", model: "forged", usage: null },
      ),
    ).toEqual({ body: "new", model: "m", usage, jobId: "job-1" });
  });

  it("adds nothing to human-authored content", () => {
    expect(withGenerationProvenance({ body: "old" }, { body: "new" })).toEqual({
      body: "new",
    });
  });
});
