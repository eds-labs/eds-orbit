import { describe, expect, it } from "vitest";
import { parseOrigins } from "./public-keys";

describe("public keys form (WP4.2b follow-up)", () => {
  it("takes one origin per line or comma, without blanks or repeats", () => {
    expect(
      parseOrigins(
        " https://a.example\n\nhttps://b.example, https://a.example \n",
      ),
    ).toEqual(["https://a.example", "https://b.example"]);
  });
});
