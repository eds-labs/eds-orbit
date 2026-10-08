import { z } from "zod";
import { chatScoped } from "../../chat.ts";
import { channelHistory } from "../channel-posts.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

export const channelTools: readonly OrbitTool[] = [
  defineTool({
    name: "channel_history",
    namespace: "content",
    description:
      "Posts per channel from the last 60 days and those already scheduled, as last read from Postiz (lastSyncAt), including posts Orbit did not make, with source (orbit or external), status and date; check to avoid repeats.",
    parameters: z
      .object({
        channels: z
          .array(z.string())
          .nullable()
          .describe("Channel IDs, at most four; all when null"),
        perChannel: z
          .number()
          .int()
          .nullable()
          .describe("Newest posts per channel, 1 to 20; 10 when null"),
      })
      .strict(),
    risk: "R0_read",
    roles: ["viewer", "editor", "owner"],
    feature: "agents",
    deferLoading: true,
    async execute(context, args) {
      const history = await chatScoped(context.scope, (tx) =>
        channelHistory(tx, context.scope, dropNullFields(args)),
      );
      return { output: history, cards: [] };
    },
  }),
];
