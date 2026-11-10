import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entity } from "@/lib/api";
import { translate, type Locale } from "@/lib/i18n";
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from "@/components/workspace-context";

// WP5 (2026-11-10): policy records have no `status` (the old table read it
// and showed "unknown") and their `version` is an optimistic lock. The
// versions are numbered by position and their state comes from `active`
// and the validity window, as savePolicy and activePolicyRecord use them.

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => ({
    data: path?.includes("ai-spend-policy")
      ? { effective: null }
      : { items: state.items },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

import { policyVersionRows, PolicyVersions } from "./policy-versions";
import { marketingSettings, PolicySetupLink } from "./settings-sections";
import { PolicyEditor } from "./policy-editor";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

/** A stored policy record; `day` orders the records (1 = oldest). */
function record(
  day: number,
  data: Record<string, unknown>,
  updatedDay = day + 1,
): Entity {
  const at = (d: number) =>
    `2026-10-${String(d).padStart(2, "0")}T09:00:00.000Z`;
  return {
    id: `policy-${day}`,
    workspaceId: "w1",
    projectId: "p1",
    kind: "policies",
    // The optimistic lock: the deactivation update bumps it to 2.
    version: data.active === false ? 2 : 1,
    data: {
      mode: "assisted",
      channels: ["social:acc-1"],
      contentTypes: ["social", "blog"],
      allowedOrigins: [],
      startAt: "2026-10-01T00:00:00.000Z",
      endAt: "2099-01-31T00:00:00.000Z",
      maxPerDay: 2,
      minIntervalMinutes: 240,
      activatedAt: at(day),
      ...data,
    },
    createdAt: at(day),
    updatedAt: at(updatedDay),
  };
}

/** Six versions, newest first as GET /policies returns them. */
const six = () => [
  record(6, { active: true }),
  ...[5, 4, 3, 2, 1].map((day) => record(day, { active: false }, day + 1)),
];

describe("policyVersionRows", () => {
  it("numbers six versions v6…v1 with one active and five replaced", () => {
    const rows = policyVersionRows(six(), NOW);
    expect(rows.map((r) => r.number)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(rows.map((r) => r.state)).toEqual([
      "active",
      "replaced",
      "replaced",
      "replaced",
      "replaced",
      "replaced",
    ]);
    expect(rows.filter((r) => r.current).map((r) => r.number)).toEqual([6]);
  });

  it("dates a replacement by the record's update and never by its lock", () => {
    const rows = policyVersionRows(six(), NOW);
    expect(rows[0]!.replacedAt).toBeNull();
    expect(rows[1]!.replacedAt).toBe("2026-10-06T09:00:00.000Z");
    expect(rows[5]!.replacedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(rows[1]!.entity.version).toBe(2);
    expect(rows[1]!.number).toBe(5);
  });

  it("marks the active record scheduled before its start", () => {
    const [row] = policyVersionRows(
      [record(1, { active: true, startAt: "2026-12-01T00:00:00.000Z" })],
      NOW,
    );
    expect(row!.state).toBe("scheduled");
  });

  it("marks the active record expired from its end", () => {
    const [row] = policyVersionRows(
      [record(1, { active: true, endAt: "2026-11-10T12:00:00.000Z" })],
      NOW,
    );
    expect(row!.state).toBe("expired");
  });

  it("orders by creation and only the newest active record is current", () => {
    const rows = policyVersionRows(
      [
        record(1, { active: true }),
        record(3, { active: false }),
        record(2, { active: true }),
      ],
      NOW,
    );
    expect(rows.map((r) => [r.entity.id, r.number, r.state])).toEqual([
      ["policy-3", 3, "replaced"],
      ["policy-2", 2, "active"],
      ["policy-1", 1, "replaced"],
    ]);
  });

  it("falls back to the creation time and leaves old records undated", () => {
    const [row] = policyVersionRows(
      [record(4, { activatedAt: undefined })],
      NOW,
    );
    expect(row!.state).toBe("replaced");
    expect(row!.activatedAt).toBe("2026-10-04T09:00:00.000Z");
    expect(row!.replacedAt).toBeNull();
  });
});

function workspace(locale: Locale): WorkspaceContextValue {
  const project = {
    id: "p1",
    workspaceId: "w1",
    name: "Synthetic project",
    language: "de",
    timezone: "Europe/Berlin",
    mode: "assisted",
    paused: false,
    generation: 1,
    role: "owner",
  } as WorkspaceContextValue["project"];
  return {
    project,
    identity: {
      user: { id: "u1", name: "Synthetic", email: "u@example.invalid" },
      projects: [project],
      workspaces: [],
    } as unknown as WorkspaceContextValue["identity"],
    locale,
    t: (key) => translate(locale, key),
    canEdit: true,
    isOwner: true,
    revision: 0,
    refresh: () => {},
    href: (path) => path,
  };
}

function render(node: React.ReactNode, locale: Locale = "de") {
  return renderToStaticMarkup(
    <WorkspaceContext.Provider value={workspace(locale)}>
      {node}
    </WorkspaceContext.Provider>,
  );
}

function PolicySection() {
  const section = marketingSettings.find((s) => s.tab.key === "policy")!;
  const shown = section.useSection();
  return <>{shown?.content}</>;
}

beforeEach(() => {
  state.items = six();
});

describe("policy settings in German", () => {
  it("shows the versions with words, not codes", () => {
    const html = render(<PolicySection />);
    expect(html).toContain("Neue Richtlinienversion");
    expect(html).toContain("Aktuelle Version");
    expect(html).toContain('<span class="badge badge-success">Aktiv</span>');
    expect(html).toContain('<span class="badge badge-neutral">Ersetzt</span>');
    expect(html).toContain("Assisted-Modus");
    expect(html).toContain("Verlauf (6 Versionen)");
    expect(html).not.toMatch(/unknown/i);
    expect(html).not.toContain("New policy version");
  });

  it("marks up the history table for assistive technology", () => {
    const html = render(<PolicyVersions items={six()} />);
    expect(html).toContain(
      "<caption>Alle Richtlinienversionen, neueste zuerst</caption>",
    );
    expect(html).toContain('<th scope="col">Version</th>');
    expect(html).toContain('<th scope="row">v6</th>');
    expect(html).toContain('<th scope="row">v1</th>');
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(/<tr aria-current="true"><th scope="row">v6<\/th>/);
    expect(html).toContain('aria-label="Version 6 öffnen"');
    expect(html).toContain('aria-label="Version 1 öffnen"');
    expect(html).toMatch(/<time datetime="2026-10-06T09:00:00.000Z">/i);
  });

  it("explains an empty policy without promising a budget", () => {
    state.items = [];
    const html = render(<PolicySection />);
    expect(html).toContain("Beobachten ist der sichere Start");
    expect(html).not.toMatch(/budget/i);
  });

  it("names the setup link after the publishing rules", () => {
    expect(render(<PolicySetupLink />)).toContain(
      "Veröffentlichungsregeln festlegen",
    );
    expect(render(<PolicySetupLink />, "en")).toContain("Set publishing rules");
  });

  it("localizes the policy editor", () => {
    const html = render(<PolicyEditor onClose={() => {}} />);
    for (const text of [
      "Neue Betriebsrichtlinie",
      "Betriebsmodus",
      "Beobachtungsmodus",
      "Mindestabstand (Minuten)",
      "Richtlinienversion speichern",
      "Einstellungen → KI &amp; Budget",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Operating mode");
  });
});
