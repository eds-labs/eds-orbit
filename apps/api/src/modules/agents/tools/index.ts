import { packageTools } from "./package-tools.ts";
import { proposalTools } from "./proposal-tools.ts";
import { readTools } from "./read-tools.ts";

/** Ordered tool set of Orbit Chat; the order is part of the cached prompt prefix. */
export const chatTools = [
  ...readTools,
  ...proposalTools,
  ...packageTools,
] as const;
