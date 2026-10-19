import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

// Every resource the card reads, by a part of its path; `requested` records
// every path asked for. A path without an entry answers 404.
const answers = vi.hoisted(() => ({}) as Record<string, unknown>);
const requested = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    useResource: (path: string | null) => {
      if (path) requested.push(path);
      const key = Object.keys(answers).find((part) => path?.includes(part));
      const found = key === undefined ? undefined : answers[key];
      const failed = found === undefined || found instanceof Error;
      return {
        data: failed ? null : found,
        error: failed
          ? Object.assign(new Error("Connections unavailable"), {
              status: found instanceof Error ? 500 : 404,
            })
          : null,
        loading: false,
        refresh: () => {},
      };
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import type {
  AttentionItem,
  AttentionResponse,
  Identity,
  Project,
} from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { WorkspaceContext } from "@/components/workspace-context";
import { webRegistry } from "@/modules/registry";
import type { AttentionState } from "./attention";
import { projectHref, routeTable } from "./routes";
import { ShellContext, type ShellContextValue } from "./shell-context";
import { SystemStatusCard } from "./system-status";

const table = routeTable(webRegistry);
const project = {
  id: "p1",
  workspaceId: "w1",
  name: "Synthetic project",
  timezone: "Europe/Berlin",
  role: "owner",
} as Project;
const identity: Identity = {
  user: { id: "u", name: "Synthetic", email: "u@example.invalid" },
  workspaces: [{ id: "w1", name: "Org one", role: "owner" }],
  projects: [project],
};

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: "x",
  moduleId: "platform",
  kind: "platform_worker_down",
  severity: "critical",
  params: {},
  navKey: "operations",
  link: "/operations",
  ...over,
});
const loaded = (items: AttentionItem[]): AttentionState => ({
  loading: false,
  data: {
    items,
    counts: {},
    status: { paused: false, aiMonth: { spentMicros: 0, limitMicros: null } },
  } satisfies AttentionResponse,
});
const connector = (id: string, data: Record<string, unknown>) => ({
  id,
  version: 1,
  kind: "connectors",
  data,
});

function render(
  attention: AttentionState,
  { locale = "en", owner = true }: { locale?: Locale; owner?: boolean } = {},
) {
  const shell = {
    hrefOf: (key: string) =>
      projectHref(
        project.id,
        table.routes.find((r) => r.key === key)!,
      ),
    attention,
    connectors: {
      providers: [{ id: "postiz", name: "Postiz" }],
      extras: [],
    },
  } as unknown as ShellContextValue;
  return renderToStaticMarkup(
    <ShellContext.Provider value={shell}>
      <WorkspaceContext.Provider
        value={{
          project,
          identity,
          locale,
          t: (k) => labels[locale][k],
          canEdit: owner,
          isOwner: owner,
          revision: 0,
          refresh: () => {},
          href: (p) => p,
        }}
      >
        <SystemStatusCard />
      </WorkspaceContext.Provider>
    </ShellContext.Provider>,
  );
}

/** The tone and text of each status line. */
const lines = (html: string) =>
  [
    ...html.matchAll(
      /<li class="system-status-line" data-tone="(\w+)"><span[^>]*><\/span>([^<]*)<\/li>/g,
    ),
  ].map((m) => [m[1], m[2]]);

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  requested.length = 0;
  answers["/connectors"] = { items: [] };
});

describe("SystemStatusCard", () => {
  it("system status shows worker unavailable in the critical colour", () => {
    const html = render(loaded([item({})]));
    expect(lines(html)[0]).toEqual(["critical", "Worker not responding"]);
    expect(lines(render(loaded([item({})]), { locale: "de" }))[0]).toEqual([
      "critical",
      "Worker antwortet nicht",
    ]);
  });

  it("the worker runs without a worker item", () => {
    expect(lines(render(loaded([])))[0]).toEqual(["ok", "Worker running"]);
  });

  it("the worker is unknown while attention failed or loads", () => {
    const failed = render({ loading: false, error: new Error("x") });
    expect(lines(failed)[0]).toEqual(["unknown", "Worker: —"]);
    expect(lines(render({ loading: true }))[0]).toEqual([
      "unknown",
      "Worker: —",
    ]);
  });

  it("never requests /operations", () => {
    render(loaded([]));
    render({ loading: true });
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.some((path) => path.includes("operations"))).toBe(false);
  });

  it("lists each connector's state and the owner's mailboxes", () => {
    answers["/connectors"] = {
      items: [
        connector("c1", { provider: "postiz", status: "write_verified" }),
        connector("c2", { provider: "matomo", status: "failed" }),
        connector("c3", { provider: "slack", status: "revoked" }),
        connector("c4", {
          provider: "email",
          status: "read_verified",
          fromAddress: "support@example.invalid",
        }),
      ],
    };
    const owner = lines(render(loaded([])));
    expect(owner.slice(1)).toEqual([
      ["ok", "Postiz · connected"],
      ["critical", "Matomo · failing"],
      ["ok", "Mailbox support@example.invalid · connected"],
    ]);
    const de = lines(render(loaded([]), { locale: "de" }));
    expect(de[1]).toEqual(["ok", "Postiz · verbunden"]);
    expect(de[3]).toEqual([
      "ok",
      "Postfach support@example.invalid · verbunden",
    ]);
    // Mailboxes are the owner's, as on the Connections page.
    const viewer = lines(render(loaded([]), { owner: false }));
    expect(viewer.map(([, text]) => text)).not.toContain(
      "Mailbox support@example.invalid · connected",
    );
  });

  it("an unverified or merely configured connection is not connected", () => {
    answers["/connectors"] = {
      items: [
        connector("c1", { provider: "postiz", status: "configured" }),
        connector("c2", { provider: "matomo", status: "unverified" }),
      ],
    };
    expect(lines(render(loaded([]))).slice(1)).toEqual([
      ["warning", "Postiz · not verified"],
      ["warning", "Matomo · not verified"],
    ]);
  });

  it("says so without connections and shows a failed read", () => {
    expect(render(loaded([]))).toContain("No connections set up");
    answers["/connectors"] = new Error("down");
    const html = render(loaded([]));
    expect(html).toContain('role="alert"');
    expect(lines(html)[0]).toEqual(["ok", "Worker running"]);
  });

  it("shows the unclear cost from the attention item", () => {
    const cost = item({
      kind: "platform_cost_unknown",
      severity: "warning",
      params: { micros: 2_200_000 },
    });
    expect(lines(render(loaded([cost])))).toContainEqual([
      "warning",
      "2.20 USD reserved with an unclear outcome",
    ]);
    expect(lines(render(loaded([cost]), { locale: "de" }))).toContainEqual([
      "warning",
      "2,20 USD mit unklarem Ausgang reserviert",
    ]);
    expect(render(loaded([]))).not.toContain("unclear outcome");
  });

  it("links to operations", () => {
    const html = render(loaded([]), { locale: "de" });
    expect(html).toContain("Systemstatus");
    expect(html).toMatch(/href="\/p\/p1\/operations"[^>]*>Betrieb/);
  });
});
