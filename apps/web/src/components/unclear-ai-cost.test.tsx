import { describe, expect, it } from "vitest";
import { unclearMicros } from "./unclear-ai-cost";

describe("unclearMicros", () => {
  it("sums the unclear part over the cost rows", () => {
    expect(
      unclearMicros([
        { unknownMicros: "2000000", count: 2 },
        { unknownMicros: "0", count: 40 },
        { unknownMicros: "600000", count: 6 },
      ]),
    ).toBe(2_600_000);
    expect(unclearMicros([])).toBe(0);
  });
});
