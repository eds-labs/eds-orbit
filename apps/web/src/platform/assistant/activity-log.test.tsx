import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webRegistry } from "@/modules/registry";
import { navigationForFeatures, routeTable } from "@/platform/shell/routes";
import { workOrderStatus } from "./activity-log";

describe("activity log of external work orders", () => {
  const table = routeTable(webRegistry);

  it("is a project page that shows in the menu while work orders are on", () => {
    const route = table.routes.find((r) => r.key === "activity")!;
    expect(route).toMatchObject({ navGroup: "project" });
    expect(route.segments).toEqual(["activity"]);
    const keys = (features: Record<string, boolean>) =>
      navigationForFeatures(table.routes, features).map((r) => r.key);
    expect(keys({})).not.toContain("activity");
    expect(keys({ workOrders: true })).toContain("activity");
  });

  it("is no longer part of Orbit Chat", () => {
    const chat = readFileSync(
      new URL("../../components/chat.tsx", import.meta.url),
      "utf8",
    );
    expect(chat).not.toContain("AssistantTasks");
  });

  it("names each status in both languages and marks finished ones", () => {
    expect(workOrderStatus("running", "de")).toEqual({
      label: "Läuft",
      done: false,
      tone: "blue",
    });
    expect(workOrderStatus("failed", "en")).toEqual({
      label: "Failed",
      done: true,
      tone: "warning",
    });
    expect(workOrderStatus("succeeded", "de")).toMatchObject({
      label: "Abgeschlossen",
      done: true,
      tone: "success",
    });
    expect(workOrderStatus("mystery", "en")).toMatchObject({
      label: "mystery",
      done: false,
    });
  });
});
