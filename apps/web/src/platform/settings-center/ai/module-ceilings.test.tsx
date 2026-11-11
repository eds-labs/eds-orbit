import { describe, expect, it } from "vitest";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ShellContext,
  type ShellContextValue,
} from "@/platform/shell/shell-context";
import { manageHref } from "../routes";
import { ModuleCeilings, ModuleCeilingsView } from "./module-ceilings";

const scope = { kind: "project", projectId: "p1" } as const;
const hrefOf = (area: string, ...rest: string[]) =>
  manageHref(scope, area, ...rest);

const calls: string[] = [];
const shell = (aiCeilings: ShellContextValue["aiCeilings"]) =>
  ({
    modules: [
      {
        id: "finance",
        displayName: { en: "Finance", de: "Finanzen" },
        enabled: true,
        nav: [],
      },
      {
        id: "work",
        displayName: { en: "Work", de: "Arbeit" },
        enabled: true,
        nav: [],
      },
    ],
    aiCeilings,
  }) as unknown as ShellContextValue;

const render = (value: ShellContextValue | null, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(
    <ShellContext.Provider value={value}>
      <ModuleCeilings locale={locale} hrefOf={hrefOf} />
    </ShellContext.Provider>,
  );

describe("ModuleCeilings", () => {
  it("lists each ceiling with its period and a link to its module section", () => {
    calls.length = 0;
    const html = render(
      shell([
        {
          moduleId: "finance",
          key: "extraction",
          label: { en: "Document extraction", de: "Belege auslesen" },
          section: "finance/ai",
          useCeiling() {
            // A real hook, as module ceilings use them.
            const [micros] = useState(2_500_000);
            calls.push("finance");
            return { micros, period: "day", on: false };
          },
        },
        {
          moduleId: "work",
          key: "loading",
          label: { en: "Still loading", de: "Lädt noch" },
          section: "work/settings",
          useCeiling() {
            calls.push("work-loading");
            return null;
          },
        },
        {
          moduleId: "work",
          key: "pm",
          label: { en: "Project manager", de: "Projektleiter" },
          section: "work/settings",
          useCeiling() {
            calls.push("work-pm");
            return { micros: 60_000_000, period: "month" };
          },
        },
      ]),
    );
    // Every entry's hook runs, in order, also the one without a value.
    expect(calls).toEqual(["finance", "work-loading", "work-pm"]);
    expect(html).toContain("AI ceilings of the modules");
    expect(html).toContain("Finance: Document extraction");
    expect(html).toContain("$2.50 per day");
    expect(html).toContain("switched off");
    expect(html).toContain('href="/manage/p/p1/modules/finance/ai"');
    expect(html).toContain("Work: Project manager");
    expect(html).toContain("$60.00 per month");
    expect(html).toContain('href="/manage/p/p1/modules/work/settings"');
    expect(html).not.toContain("Still loading");
    expect(html.match(/switched off/g)).toHaveLength(1);
    expect(html.match(/Open setting/g)).toHaveLength(2);
  });

  it("says when no module sets a ceiling", () => {
    expect(render(shell(undefined))).toContain(
      "No module of this project sets an AI ceiling.",
    );
    expect(render(null, "de")).toContain(
      "Kein Modul dieses Projekts legt eine KI-Obergrenze fest.",
    );
    expect(
      renderToStaticMarkup(<ModuleCeilingsView rows={[]} locale="en" />),
    ).not.toContain("Open setting");
  });
});
