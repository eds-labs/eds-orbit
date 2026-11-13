import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aiBudgetLink,
  googleDriveReturnLink,
  inProject,
  moduleSectionLink,
  projectCenterLink,
} from "../src/platform/management/links.ts";
import { financeCurrenciesLink, financeMailboxesLink } from "../src/modules/finance/attention.ts";
import { marketingPolicyLink } from "../src/modules/marketing/attention.ts";
import { operationFromEvidence } from "../src/modules/marketing/agents/run-operation.ts";
import { socialAccountsLink } from "../src/modules/social/links.ts";
import { oldPlaces, treeProblems } from "../../../scripts/place-words-scan.ts";

// Every link the API sends to a place in the settings center, for project p1.
// The web test api-links.test.tsx reads the fixture and resolves each link
// against the real section registry, so a link to a section that does not
// exist fails there. Rerun with UPDATE_CENTER_LINKS=1 after an intended change.
const update = process.env.UPDATE_CENTER_LINKS === "1";
const FIXTURE = new URL("./fixtures/center-links.json", import.meta.url);

/** The recovery link of a paused project, as the run operation builds it. */
function resumeRecovery(projectId: string) {
  const operation = operationFromEvidence(
    { status: "running", steps: [] },
    [{ id: "t1", status: "failed", stepKey: "s", errorCode: "PROJECT_PAUSED" }],
    [],
    { settledMicros: 0, heldMicros: 0, unknownMicros: 0, releasedMicros: 0, complete: true },
    projectId,
  );
  const step = operation.recovery.find((r) => r.action === "resume_project");
  if (!step) throw new Error("no resume_project recovery step");
  return step.href;
}

const producers = (): Array<{ producer: string; link: string }> => [
  { producer: "ai budget signal and attention items", link: aiBudgetLink("p1") },
  { producer: "marketing publishing rules attention", link: marketingPolicyLink("p1") },
  { producer: "finance mailboxes attention", link: financeMailboxesLink("p1") },
  { producer: "finance currencies attention", link: financeCurrenciesLink("p1") },
  { producer: "social accounts attention and notification", link: socialAccountsLink("p1") },
  { producer: "marketing resume project recovery", link: resumeRecovery("p1") },
  { producer: "google drive callback ready", link: googleDriveReturnLink("p1", true) },
  { producer: "google drive callback choose root", link: googleDriveReturnLink("p1", false) },
];

describe("links to the settings center", () => {
  it("matches the reviewed list", () => {
    const actual = producers();
    if (update) {
      writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + "\n");
      return;
    }
    expect(actual).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });

  it("builds encoded segments", () => {
    expect(projectCenterLink("p 1", "ai", "budget")).toBe("/manage/p/p%201/ai/budget");
    expect(moduleSectionLink("w1", "finance", "mailboxes")).toBe(
      "/manage/p/w1/modules/finance/mailboxes",
    );
  });

  it("leaves a center link alone and prefixes any other link with the project", () => {
    expect(inProject("p1", "/manage/p/p1/overview")).toBe("/manage/p/p1/overview");
    expect(inProject("p1", "/finance/review")).toBe("/p/p1/finance/review");
    expect(inProject("p1", "")).toBe("/p/p1");
  });
});

// Every text of the API that sends the reader to a settings place names it as
// the center shows it ("Administration & settings → AI → Budget"), not by an
// old page. The scan covers the whole source tree (scanner: scripts/place-words-scan.ts);
// the two Meta provider files describe Meta's own console and are skipped there.
describe("texts name settings places as the center shows them", () => {
  it("finds no old place in the API source", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    expect(treeProblems(root)).toEqual([]);
  });

  it("lets the center's own names and module pages through", () => {
    expect(oldPlaces("Administration & settings → AI → Budget")).toEqual([]);
    expect(oldPlaces("Verwaltung & Einstellungen → Mein Konto → Assistent")).toEqual([]);
    expect(oldPlaces("Support → Settings")).toEqual([]);
    expect(oldPlaces("Granted in Administration & settings → Whole system.")).toEqual([]);
  });

  it("flags the forms of the old places", () => {
    for (const text of [
      "Orbit digest. Change it in Orbit under Account → Orbit Assistant.",
      "Orbit → Settings → Integrations → Google Drive",
      "Set the route (Settings → AI & budget); Orbit",
      "See Administration & settings. Then Settings → AI.",
      "Administration → Connections (granted to the project)",
      "Settings, Support",
      "Check it in the organization settings.",
      "A missing key is granted in the administration.",
      "See Administration & settings. Then check the project settings.",
      "Integrations are managed under Connectors.",
    ])
      expect(oldPlaces(text), text).not.toEqual([]);
  });
});
