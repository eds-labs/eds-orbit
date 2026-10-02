import { z } from "zod";
import {
  conversationPackages,
  requestContentPackage,
  reviseDeliverable,
} from "../content-packages.ts";
import { chatScoped } from "../../chat.ts";
import { recentContent } from "../content-history.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

export const packageTools: readonly OrbitTool[] = [
  defineTool({
    name: "request_content_package",
    namespace: "proposals",
    description:
      "Prepare finished channel drafts (one per channel) for the user's goal. The server fills CTA, official link, language, profile and timing. It only saves a package card; nothing runs until the user confirms it there, and nothing is published.",
    parameters: z
      .object({
        goal: z
          .string()
          .describe("What the posts should achieve, in the user's words"),
        audience: z
          .string()
          .nullable()
          .describe(
            "Only when the user named an audience other than the project profile's",
          ),
        channels: z
          .array(z.string())
          .min(1)
          .describe(
            "Integration IDs from project_status.availableChannels that the active policy allows",
          ),
        factKeys: z
          .array(z.string())
          .describe(
            "Exact Verified Fact keys returned by knowledge_search that the posts may state",
          ),
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
          .describe(
            "Project-local publication date YYYY-MM-DD if the user named one; drafts are still prepared now",
          ),
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
      "Current state of this conversation's content packages: confirmation, per-channel draft status, draft text and errors. Report results only from this tool.",
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
      "Revise one channel's current draft in this conversation's started package, for example shorter or more formal. Other channels and the image stay unchanged; at most two revisions per package. Report the result only from package_status.",
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
      "Recent drafts and publications per channel (newest first, at most five per channel, default 14 days): title, excerpt, status, origin and publication state. Check it before preparing new posts so they do not repeat recent ones.",
    parameters: z
      .object({
        channels: z
          .array(z.string())
          .nullable()
          .describe("Channel integration IDs to include; all when null"),
        days: z
          .number()
          .int()
          .nullable()
          .describe("Look-back window in days, 1 to 60; 14 when null"),
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
];
