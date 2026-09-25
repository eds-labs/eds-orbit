import { z } from "zod";
import { scoped } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { retrieve } from "../../../../packages/knowledge/src/index.ts";
import { assetTools } from "./asset-tools.ts";
import { readiness } from "./readiness.ts";
import { assignedPostizChannels } from "./postiz-assignment.ts";
import { data, list } from "../shared.ts";

export type ChatCard = {
  kind: "source" | "asset" | "link" | "status";
  label: string;
  href?: string;
  status?: string;
  resourceId?: string;
  version?: number;
};

const query = z.object({ query: z.string().trim().min(1).max(2000) }).strict();
const noArgs = z.object({}).strict();
const assetQuery = z
  .object({ query: z.string().trim().max(120).default("") })
  .strict();
const campaign = z
  .object({ campaign: z.string().max(200).optional() })
  .strict();

export const readToolDefinitions = [
  {
    type: "function",
    name: "project_status",
    description:
      "Read the current project, policy, open approvals, blockers, and available channels.",
    strict: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "knowledge_search",
    description:
      "Find current model-authorized public Verified Facts and Knowledge with source references.",
    strict: false,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "approved_assets",
    description:
      "Find approved brand assets in this project. Empty query lists all. Return metadata, never asset bytes or credentials.",
    strict: false,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "analytics_memory",
    description:
      "Summarize existing metrics, insights, and confirmed preferences as observations, not verified product facts.",
    strict: false,
    parameters: {
      type: "object",
      properties: { campaign: { type: "string" } },
      additionalProperties: false,
    },
  },
] as const;

function clipped(value: unknown, max = 500) {
  return String(value ?? "").slice(0, max);
}

export async function runReadTool(
  scope: Scope,
  name: string,
  raw: unknown,
): Promise<{ result: unknown; cards: ChatCard[] }> {
  if (name === "project_status") {
    noArgs.parse(raw);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      const policies = await list(tx, scope, "policies");
      const active = policies.find((p) => data(p).active);
      const availableChannels = (await list(tx, scope, "connectors"))
        .filter((row) => data(row).provider === "postiz")
        .flatMap((row) => assignedPostizChannels(data(row)))
        .map((channel: any) => ({
          id: String(channel.id),
          name: clipped(channel.name, 120),
          provider: clipped(channel.identifier, 50),
        }));
      const approvals = (await list(tx, scope, "approvals"))
        .filter((a) => data(a).status === "pending")
        .slice(0, 15)
        .map((a) => ({
          id: a.id,
          contentId: data(a).contentId,
          status: data(a).status,
        }));
      const drafts = (await list(tx, scope, "content"))
        .filter((c) => ["draft", "review_required"].includes(data(c).status))
        .slice(0, 15)
        .map((c) => ({
          id: c.id,
          title: clipped(data(c).title, 120),
          status: data(c).status,
        }));
      const state = await readiness(tx, scope);
      return {
        result: {
          project: {
            id: project.id,
            name: project.name,
            timezone: project.timezone,
            language: project.language,
            mode: project.mode,
            paused: project.paused,
          },
          now: new Date().toISOString(),
          availableChannels,
          policy: active
            ? {
                id: active.id,
                version: active.version,
                channels: data(active).channels,
                contentTypes: data(active).contentTypes,
                modelBudget: {
                  currency: "USD",
                  approvedPaidTests: data(active).approvedPaidTests,
                  mandateActiveNow: Boolean(
                    data(active).approvedPaidTests &&
                    Date.parse(data(active).startAt) <= Date.now() &&
                    Date.parse(data(active).endAt) > Date.now() &&
                    data(active).dailyBudgetMicros > 0 &&
                    data(active).monthlyBudgetMicros > 0 &&
                    data(active).perRunBudgetMicros > 0,
                  ),
                  dailyLimitMicros: data(active).dailyBudgetMicros,
                  monthlyLimitMicros: data(active).monthlyBudgetMicros,
                  perRunLimitMicros: data(active).perRunBudgetMicros,
                  startAt: data(active).startAt,
                  endAt: data(active).endAt,
                  scope:
                    "AI provider spend limits, not a campaign or advertising budget",
                },
              }
            : null,
          approvals,
          drafts,
          readiness: { state: state.state, blockers: state.blockers },
        },
        cards: [
          {
            kind: "link" as const,
            label: "Open approvals",
            href: "/approvals",
          },
          { kind: "link" as const, label: "Missions", href: "/missions" },
        ],
      };
    });
  }
  if (name === "knowledge_search") {
    const input = query.parse(raw);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      const evidence = await retrieve(tx, scope, {
        query: input.query,
        language: project.language,
        purpose: "public",
        forModel: true,
        at: new Date(),
        topK: 6,
      });
      const value = data(evidence);
      const facts = Array.isArray(value.facts) ? value.facts.slice(0, 8) : [];
      const items = Array.isArray(value.items) ? value.items.slice(0, 6) : [];
      const sourceIds = [
        ...new Set(
          [
            ...facts.map((f: any) => f.sourceId),
            ...items.map((i: any) => i.sourceId),
          ].filter(Boolean),
        ),
      ];
      const sources = await tx.entity.findMany({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "sources",
          id: { in: sourceIds },
        },
      });
      const cards: ChatCard[] = sources.map((source) => ({
        kind: "source",
        label: clipped(data(source).name, 120),
        href: "/knowledge",
        status: "verified",
        resourceId: source.id,
        version: source.version,
      }));
      return {
        result: {
          status: value.status,
          facts: facts.map((f: any) => ({
            id: f.id,
            version: f.version,
            key: clipped(f.key, 160),
            value: clipped(f.value, 500),
            sourceId: f.sourceId,
          })),
          passages: items.map((i: any) => ({
            chunkId: i.chunkId ?? i.id,
            sourceId: i.sourceId,
            title: clipped(i.title, 160),
            text: clipped(i.text, 700),
            url: clipped(i.canonicalUrl, 500),
          })),
          gaps: (value.gaps ?? []).slice(0, 12),
        },
        cards,
      };
    });
  }
  if (name === "approved_assets") {
    const input = assetQuery.parse(raw);
    const assets = (await assetTools.getBrandAssets(scope))
      .filter(
        (a) =>
          !input.query ||
          JSON.stringify(a.data)
            .toLowerCase()
            .includes(input.query.toLowerCase()),
      )
      .slice(0, 12);
    return {
      result: assets.map((a) => ({
        id: a.id,
        version: a.version,
        name: clipped(a.data.name, 160),
        type: a.data.type,
        status: a.data.assetStatus,
      })),
      cards: assets.map((a) => ({
        kind: "asset",
        label: clipped(a.data.name, 160),
        href: `/api/projects/${scope.projectId}/assets/${a.id}/content`,
        status: "approved",
        resourceId: a.id,
        version: a.version,
      })),
    };
  }
  if (name === "analytics_memory") {
    const input = campaign.parse(raw);
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const metrics = (await list(tx, scope, "metrics"))
        .filter((x) => !input.campaign || data(x).campaign === input.campaign)
        .slice(0, 12);
      const insights = (await list(tx, scope, "insights"))
        .filter((x) => !input.campaign || data(x).campaign === input.campaign)
        .slice(0, 12);
      const preferences = (await list(tx, scope, "preferences"))
        .filter((x) => data(x).status === "confirmed")
        .slice(0, 12);
      return {
        result: {
          metrics: metrics.map((x) => ({
            id: x.id,
            version: x.version,
            source: data(x).source,
            periodStart: data(x).periodStart,
            periodEnd: data(x).periodEnd,
            sessions: data(x).sessions,
            clicks: data(x).clicks,
            conversions: data(x).conversions,
          })),
          insights: insights.map((x) => ({
            id: x.id,
            version: x.version,
            status: data(x).status,
            recommendation: clipped(data(x).recommendation),
            limitations: clipped(data(x).limitations),
          })),
          preferences: preferences.map((x) => ({
            id: x.id,
            version: x.version,
            rule: clipped(data(x).rule),
          })),
          warning:
            "Observations and preferences are not Verified Facts and do not prove causation.",
        },
        cards: [
          { kind: "link", label: "Analytics", href: "/analytics" },
          { kind: "link", label: "Marketing Memory", href: "/memory" },
        ],
      };
    });
  }
  throw new Error("CHAT_TOOL_NOT_ALLOWED");
}

const cardSchema = z
  .object({
    kind: z.enum(["source", "asset", "link", "status"]),
    label: z.string().max(160),
    href: z.string().max(600).optional(),
    status: z.string().max(80).optional(),
    resourceId: z.uuid().optional(),
    version: z.number().int().optional(),
  })
  .strict();
const resultSchemas = {
  project_status: z
    .object({
      project: z.object({ id: z.uuid(), name: z.string() }).passthrough(),
      policy: z
        .object({
          id: z.uuid(),
          version: z.number().int().positive(),
          modelBudget: z
            .object({
              currency: z.literal("USD"),
              approvedPaidTests: z.boolean(),
              mandateActiveNow: z.boolean(),
              dailyLimitMicros: z.number().int().nonnegative(),
              monthlyLimitMicros: z.number().int().nonnegative(),
              perRunLimitMicros: z.number().int().nonnegative(),
              startAt: z.iso.datetime(),
              endAt: z.iso.datetime(),
              scope: z.literal(
                "AI provider spend limits, not a campaign or advertising budget",
              ),
            })
            .strict(),
        })
        .passthrough()
        .nullable(),
      approvals: z.array(z.object({ id: z.uuid() }).passthrough()).max(15),
      drafts: z.array(z.object({ id: z.uuid() }).passthrough()).max(15),
      readiness: z
        .object({ state: z.string(), blockers: z.array(z.unknown()) })
        .passthrough(),
    })
    .passthrough(),
  knowledge_search: z
    .object({
      status: z.string(),
      facts: z
        .array(z.object({ id: z.uuid(), sourceId: z.uuid() }).passthrough())
        .max(8),
      passages: z.array(z.object({ sourceId: z.uuid() }).passthrough()).max(6),
      gaps: z.array(z.unknown()).max(12),
    })
    .passthrough(),
  approved_assets: z
    .array(
      z
        .object({
          id: z.uuid(),
          version: z.number().int(),
          name: z.string().max(160),
        })
        .passthrough(),
    )
    .max(12),
  analytics_memory: z
    .object({
      metrics: z.array(z.object({ id: z.uuid() }).passthrough()).max(12),
      insights: z.array(z.object({ id: z.uuid() }).passthrough()).max(12),
      preferences: z.array(z.object({ id: z.uuid() }).passthrough()).max(12),
      warning: z.string().max(200),
    })
    .passthrough(),
};

export function validateReadToolResult(
  name: string,
  result: unknown,
  cards: unknown,
) {
  const schema = resultSchemas[name as keyof typeof resultSchemas];
  if (!schema) throw new Error("CHAT_TOOL_NOT_ALLOWED");
  const parsed = schema.parse(result);
  const checkedCards = z.array(cardSchema).max(20).parse(cards);
  if (
    Buffer.byteLength(JSON.stringify({ result: parsed, cards: checkedCards })) >
    12000
  )
    throw new Error("CHAT_TOOL_RESULT_LIMIT");
  return { result: parsed, cards: checkedCards };
}
