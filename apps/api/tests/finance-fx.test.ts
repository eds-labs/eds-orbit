import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crossRate } from "../src/modules/finance/fx.ts";
import { parseEcbXml } from "../src/modules/finance/fx-ecb.ts";
import { convert } from "../src/modules/finance/money.ts";

const xml = readFileSync(
  new URL("./fixtures/finance/ecb-hist.xml", import.meta.url),
  "utf8",
);

describe("finance fx (pure)", () => {
  it("parses the ecb feed", () => {
    const days = parseEcbXml(xml);
    expect(days.map((d) => d.date)).toEqual([
      "2026-10-26",
      "2026-10-23",
      "2026-10-22",
    ]);
    // Both quote styles, known currencies only (JPY is ignored).
    expect(days[0]!.perEur).toEqual({ USD: "1.0910", GBP: "0.8412", CHF: "0.9481" });
    expect(days[1]!.perEur.USD).toBe("1.0853");
    expect(() => parseEcbXml("<Cube></Cube>")).toThrow(
      expect.objectContaining({ code: "FX_FEED_INVALID" }),
    );
  });

  it("cross rate EUR→USD and USD→EUR are inverse within 1e-12", () => {
    const perEur = { USD: "1.0853", GBP: "0.8375" };
    expect(crossRate(perEur, "EUR", "USD")).toBe("1.0853");
    const back = crossRate(perEur, "USD", "EUR");
    expect(back).toBe("0.921404220031");
    const product = BigInt(Math.round(1.0853 * 1e12)) * BigInt(back.replace("0.", ""));
    expect(Math.abs(Number(product - 10n ** 24n)) / 1e24).toBeLessThan(1e-11);
    expect(crossRate(perEur, "USD", "GBP")).toBe("0.771676034276");
    expect(crossRate(perEur, "GBP", "GBP")).toBe("1");
    expect(() => convert(1_000_000n, back, 2)).not.toThrow();
  });
});
