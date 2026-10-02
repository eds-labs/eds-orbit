import { z } from "zod";
import {
  conversationPackages,
  requestContentPackage,
  reviseDeliverable,
} from "../content-packages.ts";
import { chatScoped } from "../../chat.ts";
import { recentContent } from "../content-history.ts";
import { channelSlots } from "../scheduling.ts";
import { proposeSchedule } from "../package-schedule.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

export const packageTools: readonly OrbitTool[] = [
  defineTool({
    name: "request_content_package",
    namespace: "proposals",
    description:
      "One draft per channel for the user's goal; the server fills CTA, link, language, timing. Nothing runs before the user confirms; nothing is published.",
    parameters: z
      .object({
        goal: z.string().describe("The user's goal in their words"),
        audience: z.string().nullable().describe("Only if the user named one"),
        channels: z
          .array(z.string())
          .min(1)
          .describe("Policy channel IDs from project_status"),
        factKeys: z
          .array(z.string())
          .describe("Verified Fact keys from knowledge_search"),
        campaignType: z.enum(["product", "presale"]).nullable(),
        imageBrief: z
          .string()
          .nullable()
          .describe(
            "Only if asked: artwork without text, logos, UI or claims; editors need owner approval",
          ),
        intendedDate: z
          .string()
          .nullable()
          .describe("YYYY-MM-DD if named; drafts start now"),
      })
      .strict(),
    risk: "P_proposal",
    roles: ["editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context, args) {
      const { package: pkg } = await requestContentPackage(
        context.scope,
        context.conversationId,
        dropNullFields(args),
      );
      const d = pkg.data as Record<string, any>;
      return {
        output: {
          packageId: pkg.id,
          status: "awaiting_confirmation",
          ceilingMicros: d.ceilingMicros,
          deliverables: d.deliverables,
          image: d.image,
        },
        cards: [
          {
            kind: "status",
            label: "Content package ready for confirmation",
            status: "confirmation_required",
          },
        ],
      };
    },
  }),
  defineTool({
    name: "package_status",
    namespace: "content",
    description:
      "This conversation's packages: status, drafts, schedules, errors. Report only from this tool.",
    parameters: z.object({}).strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context) {
      const packages = await chatScoped(context.scope, (tx) =>
        conversationPackages(tx, context.scope, context.conversationId),
      );
      return { output: { packages: packages.slice(0, 3) }, cards: [] };
    },
  }),
  defineTool({
    name: "revise_package_deliverable",
    namespace: "content",
    description:
      "Revise one channel's draft in the started package (e.g. shorter); at most two revisions per package.",
    parameters: z
      .object({
        deliverableKey: z.string().describe("channelId from package_status"),
        instruction: z.string().describe("The user's change, in their words"),
      })
      .strict(),
    risk: "W0_internal",
    roles: ["editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context, args) {
      const snapshot = await reviseDeliverable(
        context.scope,
        context.conversationId,
        args,
      );
      return {
        output: {
          packageId: snapshot.id,
          status: snapshot.status,
          revising: (args as { deliverableKey: string }).deliverableKey,
        },
        cards: [
          {
            kind: "status",
            label: "Revision queued",
            status: "in_progress",
          },
        ],
      };
    },
  }),
  defineTool({
    name: "recent_content",
    namespace: "content",
    description:
      "Recent drafts and posts per channel (five each, default 14 days); check to avoid repeats.",
    parameters: z
      .object({
        channels: z
          .array(z.string())
          .nullable()
          .describe("Channel IDs; all when null"),
        days: z.number().int().nullable().describe("1 to 60; 14 when null"),
      })
      .strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context, args) {
      const history = await chatScoped(context.scope, (tx) =>
        recentContent(tx, context.scope, dropNullFields(args)),
      );
      return { output: history, cards: [] };
    },
  }),
  defineTool({
    name: "schedule_options",
    namespace: "calendar",
    description:
      "Free and taken slots per channel (up to 14 days) with reasons and the next free slot.",
    parameters: z
      .object({
        channels: z
          .array(z.string())
          .nullable()
          .describe("Channel IDs; all when null"),
        days: z.number().int().nullable().describe("1 to 14; 14 when null"),
      })
      .strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context, args) {
      const slots = await chatScoped(context.scope, (tx) =>
        channelSlots(tx, context.scope, dropNullFields(args)),
      );
      return { output: slots, cards: [] };
    },
  }),
  defineTool({
    name: "propose_schedule",
    namespace: "calendar",
    description:
      "Propose or move a package post's slot; an owner decides. Publishes nothing.",
    parameters: z
      .object({
        deliverableKey: z.string().describe("channelId from package_status"),
        date: z.string().nullable().describe("YYYY-MM-DD; next free when null"),
      })
      .strict(),
    risk: "P_proposal",
    roles: ["editor", "owner"],
    feature: "content_packages",
    deferLoading: false,
    async execute(context, args) {
      const result = await proposeSchedule(
        context.scope,
        context.conversationId,
        dropNullFields(args),
        {
          kind: "agent",
          userId: context.scope.userId,
          agentRunId: context.runId,
        },
      );
      return {
        output: result,
        cards:
          result.status === "proposed"
            ? [
                {
                  kind: "status",
                  label: "Schedule awaiting owner decision",
                  status: "confirmation_required",
                },
              ]
            : [],
      };
    },
  }),
];
