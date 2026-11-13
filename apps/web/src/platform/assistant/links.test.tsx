import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectLink } from "./links";

// Outside the shell a card names its own project: a path below the project
// gets the prefix, a center address from the API does not.
describe("ProjectLink for another project", () => {
  const link = (href: string) =>
    renderToStaticMarkup(
      <ProjectLink projectId="p2" href={href}>
        x
      </ProjectLink>,
    );
  it("prefixes a project path and leaves a center address alone", () => {
    expect(link("/support/tickets")).toContain('href="/p/p2/support/tickets"');
    expect(link("/manage/p/p2/ai/budget")).toContain('href="/manage/p/p2/ai/budget"');
    expect(link("/p/p2/knowledge")).toContain('href="/p/p2/knowledge"');
  });
});
