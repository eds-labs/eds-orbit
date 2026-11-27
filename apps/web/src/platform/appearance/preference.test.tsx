import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  appearanceBootstrap,
  appearanceMode,
  appearanceStorageKey,
} from "./preference";

describe("appearance preference", () => {
  it("accepts explicit modes and falls back to System for missing or invalid storage", () => {
    expect(appearanceMode("light")).toBe("light");
    expect(appearanceMode("dark")).toBe("dark");
    for (const value of [undefined, null, "", "system", "unknown"]) {
      expect(appearanceMode(value)).toBe("system");
    }
  });

  it.each(["light", "dark", "system", "unknown"])(
    "bootstraps a stored %s selection",
    (mode) => {
      const dataset: Record<string, string> = {};
      runInNewContext(appearanceBootstrap, {
        document: { documentElement: { dataset } },
        localStorage: {
          getItem(key: string) {
            expect(key).toBe(appearanceStorageKey);
            return mode;
          },
        },
      });
      expect(dataset.appearance).toBe(
        mode === "light" || mode === "dark" ? mode : undefined,
      );
    },
  );

  it("leaves appearance at System when browser storage is blocked", () => {
    const dataset: Record<string, string> = {};
    runInNewContext(appearanceBootstrap, {
      document: { documentElement: { dataset } },
      localStorage: {
        getItem() {
          throw new Error("Storage blocked");
        },
      },
    });
    expect(dataset.appearance).toBeUndefined();
  });
});
