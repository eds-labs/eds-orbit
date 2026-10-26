import { describe, expect, it } from "vitest";
import { CreativeError } from "./errors.ts";
import { sha256Hex, verifyBrand, type CreativeBrand } from "./brand.ts";

const bytes = Buffer.from("fictional-logo-bytes");

function brand(over: Partial<CreativeBrand> = {}): CreativeBrand {
  return {
    brandName: "Lumora Home",
    palette: {
      primaryColor: "#0969FF",
      secondaryColor: "#254D66",
      accentColor: "#45C2FF",
      backgroundColor: "#F6FBFF",
      surfaceColor: "#FFFFFF",
      textColor: "#071522",
      headingFont: "Inter",
      bodyFont: "DejaVu Sans",
    },
    typography: { headingWeight: 700, headingCase: "none" },
    logos: [{ role: "primary", bytes, sha256: sha256Hex(bytes) }],
    ctaStyle: "pill",
    ...over,
  };
}

function codeOf(fn: () => void): string | null {
  try {
    fn();
  } catch (error) {
    if (error instanceof CreativeError) return error.code;
    throw error;
  }
  return null;
}

describe("sha256Hex", () => {
  it("returns the lowercase hex digest", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("verifyBrand", () => {
  it("accepts a valid brand", () => {
    expect(() => verifyBrand(brand())).not.toThrow();
  });

  it("rejects a logo whose hash does not match its bytes", () => {
    const bad = brand({
      logos: [{ role: "primary", bytes, sha256: sha256Hex(Buffer.from("x")) }],
    });
    expect(codeOf(() => verifyBrand(bad))).toBe("BRAND_ASSET_INTEGRITY_FAILED");
  });

  it("checks the hash of every logo, not only the primary one", () => {
    const bad = brand({
      logos: [
        { role: "primary", bytes, sha256: sha256Hex(bytes) },
        { role: "mark", bytes, sha256: "0".repeat(64) },
      ],
    });
    expect(codeOf(() => verifyBrand(bad))).toBe("BRAND_ASSET_INTEGRITY_FAILED");
  });

  it("requires a primary logo", () => {
    const bad = brand({
      logos: [{ role: "mark", bytes, sha256: sha256Hex(bytes) }],
    });
    expect(codeOf(() => verifyBrand(bad))).toBe("PRIMARY_LOGO_REQUIRED");
    expect(codeOf(() => verifyBrand(brand({ logos: [] })))).toBe(
      "PRIMARY_LOGO_REQUIRED",
    );
  });

  it("rejects a palette colour that is not a 6-digit hex value", () => {
    const base = brand();
    const bad = brand({ palette: { ...base.palette, textColor: "red" } });
    expect(codeOf(() => verifyBrand(bad))).toBe("INVALID_BRAND_COLOR");
  });

  it("rejects a font outside the allowed set", () => {
    const base = brand();
    const bad = brand({
      palette: { ...base.palette, headingFont: "Comic Sans" as never },
    });
    expect(codeOf(() => verifyBrand(bad))).toBe("INVALID_BRAND_FONT");
  });
});
