import { describe, expect, it } from "vitest";
import { imagePriceConfigured } from "./index.ts";

describe("imagePriceConfigured", () => {
  it("requires a non-zero ceiling with a verification date and never expires", () => {
    expect(
      imagePriceConfigured({
        maxCostMicrosPerImage: 1_000_000,
        pricingVerifiedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      imagePriceConfigured({
        maxCostMicrosPerImage: 0,
      }),
    ).toBe(false);
  });
});
