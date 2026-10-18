/**
 * The native MCP `orbit_profile` tool (Track M, WP-M3): the opaque Orbit
 * user id of the connected account, so a client can tell accounts apart.
 * Never an e-mail address or a name (09 §5.4).
 */
import { z } from "zod";
import type { NativeTool } from "../native-tools.ts";

export const orbitProfile: NativeTool = {
  name: "orbit_profile",
  description: "Return the opaque Orbit user id of the connected account.",
  risk: "R0_read",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ id: z.string() }).strict(),
  meta: { "openai/profile": true },
  async run(principal) {
    return { id: principal.userId };
  },
};
