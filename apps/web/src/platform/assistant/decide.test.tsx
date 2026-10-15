import { beforeEach, describe, expect, it, vi } from "vitest";
const posted = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  post: vi.fn(async (...args: unknown[]) => {
    posted.calls.push(args);
    return {};
  }),
}));
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceContext } from "@/components/workspace-context";
import { useDecideActionRequest } from "./decide";

function decider() {
  let decide!: ReturnType<typeof useDecideActionRequest>;
  function Probe() {
    decide = useDecideActionRequest();
    return null;
  }
  renderToStaticMarkup(
    <WorkspaceContext.Provider value={{ project: { id: "p1" } } as never}>
      <Probe />
    </WorkspaceContext.Provider>,
  );
  return decide;
}
const request = { id: "r1", version: 3, packageHash: "a".repeat(64) };

describe("useDecideActionRequest", () => {
  beforeEach(() => {
    posted.calls = [];
  });

  it("posts the exact request and sends image consent only when given", async () => {
    const decide = decider();
    await decide(request, "approve");
    await decide(request, "approve", false);
    await decide(request, "approve", true);
    await decide(request, "reject");
    const path = "/projects/p1/action-requests/r1/decide";
    const base = { version: 3, packageHash: "a".repeat(64) };
    expect(posted.calls).toEqual([
      [path, { ...base, decision: "approve" }],
      [path, { ...base, decision: "approve", imageRightsConsent: false }],
      [path, { ...base, decision: "approve", imageRightsConsent: true }],
      [path, { ...base, decision: "reject" }],
    ]);
  });
});
