import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentGraph,
  layoutGraph,
  type ActivityRun,
  type ActivityStep,
} from "./agent-activity";

const step = (
  key: string,
  status: string,
  dependsOn: string[] = [],
  optionalDependsOn: string[] = [],
): ActivityStep => ({
  key,
  role: key.split(":")[0]!,
  status,
  dependsOn: [...dependsOn, ...optionalDependsOn],
  optionalDependsOn,
  errorCode: null,
  channel: key.includes(":") ? key.split(":")[1]! : null,
  channelName: key.includes(":") ? `Channel ${key.split(":")[1]}` : null,
});
const run = (steps: ActivityStep[], status = "running"): ActivityRun => ({
  id: "run",
  assignmentId: "assignment",
  assignmentName: "Daily posts",
  date: "2026-10-11",
  status,
  plannedAt: null,
  updatedAt: "2026-10-11T02:00:00.000Z",
  firstSlotAt: "2026-10-11T08:00:00.000Z",
  costMicros: 1200,
  ceilingMicros: 160000,
  delivery: "postiz_draft",
  steps,
});
const plan = [
  step("analytics", "done"),
  step("research", "running"),
  step("strategy", "pending", [], ["analytics", "research"]),
  step("copywriter:x", "pending", ["strategy"]),
  step("copywriter:tg", "pending", ["strategy"]),
  step("review", "pending", ["copywriter:x", "copywriter:tg"]),
];

describe("layoutGraph", () => {
  it("puts inputs left of the steps that use them and ends in the delivery", () => {
    const { nodes } = layoutGraph(plan, run(plan));
    const x = (key: string) => nodes.find((node) => node.key === key)!.x;
    expect(x("analytics")).toBe(x("research"));
    expect(x("strategy")).toBeGreaterThan(x("research"));
    expect(x("copywriter:x")).toBe(x("copywriter:tg"));
    expect(x("copywriter:x")).toBeGreaterThan(x("strategy"));
    expect(x("review")).toBeGreaterThan(x("copywriter:x"));
    expect(x("delivery")).toBeGreaterThan(x("review"));
  });

  it("marks data flowing out of working and finished steps", () => {
    const { edges } = layoutGraph(plan, run(plan));
    const edge = (from: string, to: string) =>
      edges.find((e) => e.from === from && e.to === to)!;
    expect(edge("research", "strategy")).toMatchObject({
      state: "flowing",
      optional: true,
    });
    expect(edge("analytics", "strategy").state).toBe("idle");
    expect(edge("strategy", "copywriter:x")).toMatchObject({
      state: "idle",
      optional: false,
    });
    expect(edge("review", "delivery").state).toBe("idle");
  });

  it("shows a finished run as delivered and a failed input as blocking", () => {
    const steps = [
      step("strategy", "done"),
      step("copywriter:x", "failed", ["strategy"]),
      step("review", "skipped", ["copywriter:x"]),
    ];
    const { nodes, edges } = layoutGraph(steps, run(steps, "failed"));
    expect(nodes.find((node) => node.key === "delivery")!.status).toBe(
      "failed",
    );
    expect(
      edges.find((e) => e.from === "copywriter:x" && e.to === "review")!.state,
    ).toBe("blocked");
  });
});

describe("AgentGraph", () => {
  it("draws every specialist with its live state and the delivery slot", () => {
    const html = renderToStaticMarkup(
      <AgentGraph de run={run(plan)} timezone="Europe/Berlin" />,
    );
    expect(html).toContain("Recherche");
    expect(html).toContain("arbeitet");
    expect(html).toContain("Channel x · wartet");
    expect(html).toContain("Postiz-Entwurf");
    expect(html).toContain("10:00 · wartet");
    // A working step pulses and its outgoing edge carries a moving packet.
    expect(html).toContain("agent-halo");
    expect(html).toContain("animateMotion");
  });

  it("shows the ready team while no run exists", () => {
    const html = renderToStaticMarkup(
      <AgentGraph de={false} run={null} timezone="Europe/Berlin" />,
    );
    for (const label of [
      "Analytics",
      "Research",
      "Strategy",
      "Copywriter",
      "Visual",
      "Review",
      "Delivery",
    ])
      expect(html).toContain(label);
    expect(html).toContain("ready");
    expect(html).not.toContain("animateMotion");
  });
});
