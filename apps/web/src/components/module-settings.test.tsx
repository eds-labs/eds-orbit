import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ModulePanel, type ModuleRow } from "./module-settings";

const row = (id: string, enabled: boolean, dependsOn: string[] = []) =>
  ({
    id,
    displayName: {
      en: id === "marketing" ? "Marketing" : "Knowledge",
      de: id === "marketing" ? "Marketing" : "Wissen",
    },
    version: "1.0.0",
    dependsOn,
    enabled,
    explicit: false,
    changedBy: null,
    changedAt: null,
  }) satisfies ModuleRow;
const MODULES = [
  row("knowledge", true),
  row("marketing", false, ["knowledge"]),
];
const render = (props: Partial<Parameters<typeof ModulePanel>[0]> = {}) =>
  renderToStaticMarkup(
    <ModulePanel
      de={false}
      switchable
      isOwner
      modules={MODULES}
      pending={false}
      error={null}
      confirm={null}
      onConfirm={() => {}}
      onChange={() => {}}
      {...props}
    />,
  );

describe("ModulePanel", () => {
  it("lists every module with its state and dependencies", () => {
    const html = render();
    expect(html).toContain("Knowledge");
    expect(html).toContain("needs Knowledge");
    expect(html).toContain("Turn off: Knowledge");
    expect(html).toContain("Turn on: Marketing");
    expect(render({ de: true })).toContain("braucht Wissen");
  });

  it("offers switching only to owners and only with the flag on", () => {
    expect(render({ isOwner: false })).not.toContain("Turn off");
    const off = render({ switchable: false });
    expect(off).not.toContain("Turn off");
    expect(off).toContain("Switching modules is not enabled");
  });

  it("asks before turning a module off and says nothing is deleted", () => {
    const html = render({ confirm: MODULES[0] });
    expect(html).toContain("Turn off Knowledge?");
    expect(html).toContain("Nothing is deleted");
  });

  it("explains the dependency errors of the API", () => {
    expect(render({ error: "MODULE_REQUIRED" })).toContain(
      "Turn that module off first",
    );
    expect(render({ error: "MODULE DEPENDENCY DISABLED", de: true })).toContain(
      "Schalte jenes zuerst ein",
    );
    expect(render({ error: "Something else" })).toContain("Something else");
  });
});
