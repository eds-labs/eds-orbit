import { z } from "zod";
import {
  conversationPackages,
  requestContentPackage,
  reviseDeliverable,
} from "../content-packages.ts";
import { chatScoped } from "../../chat.ts";
import { recentContent } from "../content-history.ts";
import { channelSlots } from "../scheduling.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

export const packageTools: readonly OrbitTool[] = [
  defineTool({
    name: "request_content_package",
    namespace: "proposals",
    description:
      "Prepare one draft per channel for the user's goal; the server fills CTA, link, language and timing. Saves a package card only: nothing runs before the user confirms it, nothing is published.",
    parameters: z
      .object({
        goal: z
          .string()
          .describe("What the posts should achieve, in the user's words"),
        audience: z
          .string()
          .nullable()
          .describe("Only if the user named another audience"),
        channels: z
          .array(z.string())
          .min(1)
          .describe("Channel IDs from project_status that the policy allows"),
        factKeys: z
          .array(z.string())
          .describe("Verified Fact keys from knowledge_search"),
        campaignType: z.enum(["product", "presale"]).nullable(),
        imageBrief: z
          .string()
          .nullable()
          .describe(
            "Only if the user asked for an image: one artwork description without text, logos, UI or claims. For an editor the image waits for an owner's approval.",
          ),
        intendedDate: z
          .string()
          .nullable()
          .describe("Project-local YYYY-MM-DD if named; drafts start now"),
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
      "This conversation's packages: confirmation, per-channel status, draft text and errors. Report results only from this tool.",
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
      "Revise one channel's current draft in the started package (e.g. shorter). Other channels and the image stay; at most two revisions per package.",
    parameters: z
      .object({
        deliverableKey: z
          .string()
          .describe("The channelId of the deliverable from package_status"),
        instruction: z
          .string()
          .describe(
            "The user's change request for this one draft, in their words",
          ),
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
      "Recent drafts and publications per channel (newest first, five per channel, default 14 days). Check it before new posts to avoid repeats.",
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
      "Free and taken publication slots per channel (project timezone, up to 14 days) with reasons and the next free slot. Schedules nothing.",
    parameters: z
      .object({
        channels: z
          .array(z.string())
          .nullable()
          .describe("Channel IDs; policy channels when null"),
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
];
