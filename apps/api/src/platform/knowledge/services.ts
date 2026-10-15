/**
 * The platform's knowledge services (WP3.2, plans/orbit-modularization/05
 * §2): one facade for every consumer (assistant, marketing, later support),
 * available whether or not the knowledge management module is enabled.
 * Changing operations carry the registered impact handlers (engine.ts).
 */
export {
  getActiveIndex,
  retrieve,
  validateEvidence,
} from "../../../../../packages/knowledge/src/index.ts";
export {
  ingest,
  revokeDocument,
  revokeSource,
  setFact,
  setSourceRights,
  withdrawFact,
} from "./engine.ts";
export { retrieveHybrid } from "./retrieval.ts";
