import { describe, expect, it } from "vitest";
import { routeTaskClasses } from "./ai-settings";

// CS-D6 (R64): the Creative Studio's vision review gets a route only while it is on.
describe("routeTaskClasses", () => {
  it("lists the creative vision review only with the Creative Studio on", () => {
    const ids = (studio: boolean) =>
      routeTaskClasses(studio).map((task) => task.id);
    expect(ids(false)).not.toContain("creative_review");
    expect(ids(true)).toContain("creative_review");
    expect(ids(false)).toContain("issue_triage");
  });
});
