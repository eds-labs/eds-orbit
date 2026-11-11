import { describe, expect, it } from "vitest";
import type { AiDefaults } from "@/lib/ai-presets";
import { defaultsPayload } from "./ai-defaults-ui";

// F-8 risk 3: the organization's and the system's standard keep the route of
// a task the form does not show (the Creative Studio's while it is off).
describe("defaultsPayload", () => {
  it("keeps a hidden task route of the standard", () => {
    const current: AiDefaults = {
      provider: "anthropic",
      level: "balanced",
      taskRoutes: { creative_review: { model: "m1", maxOutputTokens: 1500 } },
    };
    expect(
      defaultsPayload({ provider: "anthropic", level: "balanced", imageModel: "", advanced: "no" }, current)
        .taskRoutes,
    ).toEqual(current.taskRoutes);
  });

  it("drops a shown route that was cleared and keeps the image model", () => {
    const current: AiDefaults = {
      provider: "openai",
      level: "quality",
      taskRoutes: { chat_operator: { model: "m2", maxOutputTokens: 2000 } },
    };
    expect(
      defaultsPayload(
        { provider: "openai", level: "quality", imageModel: "img-1", advanced: "yes", "task-chat_operator": "" },
        current,
      ),
    ).toEqual({ provider: "openai", level: "quality", imageModel: "img-1", taskRoutes: {} });
  });
});
