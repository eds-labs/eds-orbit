import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PreferencesForm,
  preferencesPutBody,
  type PreferencesView,
} from "./proactive-preferences";
import {
  AllProjectsList,
  bellTabs,
} from "@/components/notification-bell";
import {
  SignalSettingsPanel,
  signalSettingsBody,
  type SignalSetting,
} from "@/components/signal-settings";
import { badgeLabel, summaryPath, streamWanted } from "@/platform/assistant/notification-summary";

// Proactive UI (ADR 0023): preferences on /account/assistant, the bell's
// "All projects" tab, the bubble badge and the project's signal switches.

const view: PreferencesView = {
  personalSpaceId: "00000000-0000-4000-8000-000000000001",
  version: 3,
  preferences: {
    timeZone: "Europe/Berlin",
    notifications: {
      email: { info: "immediate", attention: "immediate", urgent: "immediate" },
      telegram: { info: "off", attention: "immediate", urgent: "immediate" },
    },
    quietHours: { enabled: true, start: "22:00", end: "07:00", urgentBreaks: false },
    digest: { time: "08:00" },
    briefing: {
      enabled: true,
      rhythm: "weekdays",
      time: "07:30",
      projectIds: null,
      sections: { approvals: true, agentWork: true, urgentTickets: false, dueTasks: true, budget: true },
      skipEmpty: true,
      email: false,
      aiSummary: false,
    },
  },
  channels: { systemMail: false, telegram: { available: true, status: "linked", linkedAt: null } },
};

describe("notification preferences (ADR 0023)", () => {
  it("sends every section bound to the version read", () => {
    expect(preferencesPutBody(3, view.preferences)).toEqual({
      version: 3,
      timeZone: "Europe/Berlin",
      notifications: view.preferences.notifications,
      quietHours: view.preferences.quietHours,
      digest: view.preferences.digest,
      briefing: view.preferences.briefing,
    });
  });

  it("renders labelled controls for both channels once Telegram is linked, in German", () => {
    const html = renderToStaticMarkup(
      <PreferencesForm view={view} de projects={[{ id: "p1", name: "Synthetic project" }]} pending={false} error={null} success={false} onSave={() => {}} />,
    );
    expect(html).toContain('aria-label="E-Mail: Dringend"');
    expect(html).toContain('aria-label="Telegram: Info"');
    expect(html).toContain("Ruhezeiten");
    expect(html).toContain("Werktags");
    expect(html).toContain("Alle Projekte");
    // No system sender: the hint shows and the e-mail briefing is disabled.
    expect(html).toContain("kein System-Absender");
    expect(html).toContain("<legend>Briefing</legend>");
  });

  it("offers only e-mail while no Telegram bot is linked", () => {
    const html = renderToStaticMarkup(
      <PreferencesForm
        view={{ ...view, channels: { ...view.channels, telegram: { available: true, status: "none", linkedAt: null } } }}
        de={false}
        projects={[]}
        pending={false}
        error={null}
        success
        onSave={() => {}}
      />,
    );
    expect(html).not.toContain('aria-label="Telegram: Info"');
    expect(html).toContain("Saved.");
  });
});

describe("bell and badge (ADR 0023)", () => {
  it("offers the All projects tab only while the summary answers", () => {
    expect(bellTabs(false, true).map((t) => t.label)).toEqual(["This project", "All projects"]);
    expect(bellTabs(true, false).map((t) => t.key)).toEqual(["project"]);
  });

  it("lists notices with their project, repeat count and severity, and follows Orbit links only", () => {
    const html = renderToStaticMarkup(
      <AllProjectsList
        items={[
          {
            id: "n1",
            projectId: "p1",
            projectName: "Synthetic project",
            personal: false,
            moduleId: "platform",
            kind: "agent_work_failed",
            title: "An agent run did not finish (AGENT_LIMIT)",
            body: "",
            link: "//evil.example",
            severity: "urgent",
            occurrences: 3,
            readAt: null,
            createdAt: "2026-11-04T10:00:00.000Z",
            lastOccurredAt: "2026-11-04T11:00:00.000Z",
          },
        ]}
        de={false}
        locale="en"
        timezone="UTC"
        pending={false}
        onRead={() => {}}
      />,
    );
    expect(html).toContain("Synthetic project · 3×");
    expect(html).toContain("Urgent");
    expect(html).not.toContain("evil.example");
  });

  it("shows a short badge and polls unless the server offers the stream", () => {
    expect([0, 3, 12].map(badgeLabel)).toEqual(["", "3", "9+"]);
    expect(summaryPath("w1")).toBe("/notifications/summary?workspaceId=w1");
    // No EventSource in this environment: polling.
    expect(streamWanted({ realtime: true })).toBe(typeof EventSource !== "undefined");
    expect(streamWanted({ realtime: false })).toBe(false);
  });
});

describe("signal switches (ADR 0023)", () => {
  const signals: SignalSetting[] = [
    { key: "platform.agent_work_failed", moduleId: "platform", kind: "agent_work_failed", title: { en: "Failed agent runs", de: "Fehlgeschlagene Agenten-Ausführungen" }, source: "event", switchable: true, on: true },
    { key: "support.urgent_ticket", moduleId: "support", kind: "support_sla_breached", title: { en: "Urgent tickets", de: "Dringende Tickets" }, source: "mapping", switchable: false, on: true },
  ];
  it("sends only changed switches of detectors", () => {
    expect(signalSettingsBody(signals, { "platform.agent_work_failed": false, "support.urgent_ticket": false })).toEqual({
      signals: { "platform.agent_work_failed": false },
    });
    expect(signalSettingsBody(signals, { "platform.agent_work_failed": true })).toEqual({ signals: {} });
  });
  it("shows mappings without a switch and hides saving from non-owners", () => {
    const html = renderToStaticMarkup(
      <SignalSettingsPanel data={{ mayEdit: false, signals }} de pending={false} error={null} onSave={() => {}} />,
    );
    expect(html).toContain("Bestehende Benachrichtigung");
    expect(html).toContain("disabled");
    expect(html).not.toContain("Speichern");
  });
});
