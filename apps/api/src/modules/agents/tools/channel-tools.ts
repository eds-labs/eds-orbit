import { z } from "zod";
import { chatScoped } from "../../chat.ts";
import { channelHistory, syncChannelPosts } from "../channel-posts.ts";
import { defineTool, dropNullFields, type OrbitTool } from "./registry.ts";

export const channelTools: readonly OrbitTool[] = [
  defineTool({
    name: "channel_history",
    namespace: "content",
    description:
      "Posts already published per channel in the last 60 days, from Postiz, including posts Orbit did not make, with source (orbit or external) and date; check to avoid repeats.",
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
      // Refresh first; at most hourly, and a Postiz outage only leaves the stored history.
      await syncChannelPosts(context.scope).catch(() => undefined);
      const history = await chatScoped(context.scope, (tx) =>
        channelHistory(tx, context.scope, dropNullFields(args)),
      );
      return { output: history, cards: [] };
    },
  }),
];
