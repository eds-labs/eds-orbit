import { z } from "zod";
import { createProposal } from "../../chat.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

// Model-facing shape of today's propose_campaign; createProposal still runs
// proposeInput and missionSchema on the result.
const mission = z
  .object({
    title: z.string(),
    goal: z.string(),
    audience: z.string(),
    product: z.string().nullable(),
    allowedTopics: z.array(z.string()).nullable(),
    language: z.enum(["en", "de"]),
    channels: z
      .array(z.string())
      .min(1)
      .describe("Assigned integration IDs also allowed by the active policy"),
    startAt: z.string().describe("ISO 8601 UTC timestamp"),
    endAt: z.string().describe("ISO 8601 UTC timestamp after startAt"),
    maxContents: z.number().int().min(1).max(30),
    targetAction: z
      .string()
      .describe("Exact primary CTA from the current marketing profile"),
    targetUrl: z
      .string()
      .describe("Exact official target URL from the current marketing profile"),
    sourceIds: z
      .array(z.string())
      .min(1)
      .describe("Approved source IDs returned by knowledge_search"),
    assetIds: z.array(z.string()).nullable(),
    contentType: z.enum([
      "social",
      "blog",
      "newsletter",
      "ad",
      "script",
      "community",
    ]),
    campaignType: z.enum(["product", "presale"]),
    profileVersion: z.number().int().min(1),
  })
  .strict()
  .describe(
    "One draft-only mission. Use current project_status profile, policy and assigned channel IDs, plus source IDs returned by knowledge_search. The server validates every field again before saving.",
  );

export const proposalTools: readonly OrbitTool[] = [
  defineTool({
    name: "propose_campaign",
    namespace: "proposals",
    description:
      "Save a reviewable draft-only mission proposal only after all mission fields, approved source IDs, relevant verified fact IDs, channels, period, campaign type, profile version, primary CTA and official target URL are known. This does not execute the mission.",
    parameters: z
      .object({ mission, factIds: z.array(z.string()).min(1) })
      .strict(),
    risk: "P_proposal",
    roles: ["editor", "owner"],
    deferLoading: false,
    async execute(context, args) {
      const proposal = await createProposal(
        context.scope,
        context.conversationId,
        dropNullFields(args),
      );
      return {
        output: {
          proposalId: proposal.id,
          version: proposal.version,
          hash: proposal.payloadHash,
          status: proposal.status,
          payload: proposal.payload,
        },
        cards: [
          {
            kind: "status",
            label: "Proposal ready for confirmation",
            status: "confirmation_required",
          },
        ],
      };
    },
  }),
];
