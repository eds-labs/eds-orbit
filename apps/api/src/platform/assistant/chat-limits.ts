// The bounds of one assistant turn, shared by the chat runner and the cost
// ceiling of delegated work orders. They bound size and loops; spend stays
// bounded by the policy's budgets, since every model call reserves its
// estimated cost from the bytes it actually sends.

/** Model calls per turn: Claude researches over several rounds, then acts. */
export const CHAT_MAX_MODEL_CALLS = 8;
/** Tool calls per turn: Claude calls tools in parallel, each one counts. */
export const CHAT_MAX_TOOL_CALLS = 16;
/**
 * Bytes of one model call (instructions, conversation and tools). Claude
 * receives every tool in full; 64 KB left too little room once tool
 * results arrived (FamilyPlan, 2026-10-24).
 */
export const CHAT_MAX_INPUT_BYTES = 128_000;
/**
 * Visible answer characters per turn (CHAT_OUTPUT_LIMIT); a failed turn keeps
 * up to this much as its partial result, and work order results return it.
 */
export const CHAT_MAX_OUTPUT_CHARS = 8000;
