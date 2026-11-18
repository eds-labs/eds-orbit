import { describe, expect, it } from "vitest";
import { findRepository, type PmRepository } from "../src/modules/work/pm/settings-schema.ts";

const repo = (key: string, fullName: string): PmRepository => ({
  key,
  label: key,
  provider: "github",
  fullName,
  defaultBranch: "main",
  dispatch: { kind: "manual" },
});

describe("coding repository references", () => {
  const repositories = [repo("eds-orbit", "eds-labs/eds-orbit"), repo("site", "eds-labs/familyplan-site")];

  it("finds a repository by its key", () => {
    expect(findRepository(repositories, "eds-orbit")?.key).toBe("eds-orbit");
    expect(findRepository(repositories, " site ")?.key).toBe("site");
  });

  it("finds a repository by its GitHub owner/name, ignoring case", () => {
    expect(findRepository(repositories, "eds-labs/eds-orbit")?.key).toBe("eds-orbit");
    expect(findRepository(repositories, "EDS-Labs/FamilyPlan-Site")?.key).toBe("site");
  });

  it("prefers an exact key over another repository's owner/name", () => {
    const tricky = [repo("a", "x/b"), repo("x/b-is-not-a-key", "x/a")];
    expect(findRepository(tricky, "a")?.fullName).toBe("x/b");
  });

  it("knows nothing that is not configured", () => {
    expect(findRepository(repositories, "eds-labs")).toBeUndefined();
    expect(findRepository(repositories, "other/eds-orbit")).toBeUndefined();
    expect(findRepository([], "eds-orbit")).toBeUndefined();
  });
});
