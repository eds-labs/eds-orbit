import { describe, expect, it } from "vitest";
import { brandTermsField } from "./profile-fields";

describe("brandTerms in the profile editor (WP3.4)", () => {
  it("sends lower-case words, one per line, without duplicates", () => {
    expect(brandTermsField(" Acme \npro\n\nACME\n")).toEqual({
      brandTerms: ["acme", "pro"],
    });
  });

  it("leaves the field out when empty, keeping the built-in words", () => {
    expect(brandTermsField("")).toEqual({});
    expect(brandTermsField(" \n \n")).toEqual({});
  });
});
