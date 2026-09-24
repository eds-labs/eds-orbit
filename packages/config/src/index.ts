import { z } from "zod";
export const configVersion = 1;
export const modelRoutes = {
  fast: "gpt-5.6-luna",
  standard: "gpt-5.6-terra",
  quality: "gpt-5.6-sol",
  escalation: "gpt-6-astra",
} as const;
export const embeddingProfile = {
  id: "openai-small-1536-v1",
  model: "text-embedding-3-small",
  dimensions: 1536,
  metric: "cosine",
  generation: 1,
} as const;
export const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),
  QUEUE_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9-]{1,50}$/)
    .default("orbit"),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.url().default("http://localhost:4310"),
  PORT: z.coerce.number().default(4311),
  EXECUTION_MODE: z.enum(["test", "live"]).default("test"),
  ENABLE_EXTERNAL_WRITES: z.enum(["false", "true"]).default("false"),
  OPENAI_API_KEY: z.string().optional(),
  ORBIT_SETUP_TOKEN: z.string().min(20),
  CREDENTIAL_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  PUBLISHER_INSTANCE_ID: z.string().min(1).default("local-orbit"),
  LIVE_RAG_EVAL_PASSED: z.enum(["false", "true"]).default("false"),
});
export function loadConfig() {
  return configSchema.parse(process.env);
}
export function routeTask(task: string, attempt: number, escalations: number) {
  if (attempt < 0 || attempt > 2 || escalations > 1)
    throw new Error("RETRY_LIMIT");
  if (attempt === 2) {
    if (escalations !== 0) throw new Error("ESCALATION_LIMIT");
    return modelRoutes.escalation;
  }
  if (["classify", "extract", "metadata"].includes(task))
    return modelRoutes.fast;
  if (["plan", "blog", "review", "conflict"].includes(task))
    return modelRoutes.quality;
  return modelRoutes.standard;
}
