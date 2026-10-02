import { z } from "zod";
import {
  conversationPackages,
  requestContentPackage,
} from "../content-packages.ts";
import { chatScoped } from "../../chat.ts";
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
];
