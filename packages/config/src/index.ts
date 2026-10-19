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
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The MCP protected resource identifier (RFC 8707 / RFC 9728): HTTPS without
 * query, fragment or credentials. Plain http only for loopback development.
 */
export function isValidMcpResource(value: string) {
  if (value.includes("?") || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * The canonical spelling of an MCP resource identifier (WP-M5): scheme and
 * host lower-cased, a default port dropped (both by URL parsing) and a
 * trailing slash removed, except for the bare origin. The path keeps its case.
 * A value that is not a URL is returned unchanged (validation rejects it).
 */
export function normalizeMcpResource(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  const href = url.href;
  return url.pathname !== "/" && href.endsWith("/") ? href.slice(0, -1) : href;
}

// Compose passes an unset optional variable as "" (`${NAME:-}`); for a
// validated optional value that means "not set", never an invalid value.
const unset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema);
const baseConfigSchema = z.object({
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
  // Anthropic Claude API key: a bootstrap fallback only, like OPENAI_API_KEY;
  // the owner-saved encrypted key in Orbit Settings takes precedence.
  ANTHROPIC_API_KEY: z.string().optional(),
  // The provider whose tier models serve task classes without an explicit
  // route when no Orbit configuration is saved (bootstrap only).
  AI_DEFAULT_PROVIDER: unset(z.enum(["openai", "anthropic"]).default("openai")),
  ORBIT_SETUP_TOKEN: z.string().min(20),
  CREDENTIAL_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  GOOGLE_DRIVE_CLIENT_ID: z.string().optional(),
  GOOGLE_DRIVE_CLIENT_SECRET: z.string().optional(),
  PUBLISHER_INSTANCE_ID: z.string().min(1).default("local-orbit"),
  LIVE_RAG_EVAL_PASSED: z.enum(["false", "true"]).default("false"),
  // New content packages from Orbit Chat; existing packages keep running when off.
  ORBIT_CONTENT_PACKAGES: z.enum(["false", "true"]).default("false"),
  // Client-executed tool search for Orbit Chat on models from gpt-5.4 (ADR 0007).
  ORBIT_TOOL_SEARCH: z.enum(["false", "true"]).default("false"),
  // Orbit Agents: assignments, runs and specialists; everything stays off when false.
  ORBIT_AGENTS: z.enum(["false", "true"]).default("false"),
  // Assignment images: "true" sends style references through images.edit (verified from types only);
  // off by default, images then follow the stored style description.
  ORBIT_IMAGE_REFERENCES: z.enum(["false", "true"]).default("false"),
  // The review agent's approval stands in for the owner's only when "true"; set after the review
  // eval passed (Approval J). While "false", assignment posts wait for the owner.
  ORBIT_AGENT_REVIEW_AUTHORITY: z.enum(["false", "true"]).default("false"),
  // Owners may switch modules per project (WP1.4). Activation is recorded but
  // not yet enforced; every module keeps working while this is "false".
  ORBIT_MODULES: z.enum(["false", "true"]).default("false"),
  // Orbit as OAuth 2.1 authorization server for MCP clients (Track M, WP-M1).
  // Nothing is registered and /api/auth behaves as before while "false".
  ORBIT_MCP_OAUTH: z.enum(["false", "true"]).default("false"),
  // Dynamic client registration (RFC 7591) on top of CIMD; closed by default.
  ORBIT_MCP_DCR: z.enum(["false", "true"]).default("false"),
  // Canonical MCP resource and token audience; defaults to ${APP_ORIGIN}/mcp.
  MCP_RESOURCE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .refine(isValidMcpResource, {
        message:
          "MCP_RESOURCE must be an https URL without query, fragment or credentials (http only on loopback)",
      })
      .optional(),
  ),
  // Hosts (exact or subdomain) whose Client ID Metadata Documents are fetched.
  ORBIT_MCP_CIMD_HOSTS: z.string().default("chatgpt.com"),
  // The separate MCP gateway process (Track M, WP-M2). It serves the gateway
  // only when this and ORBIT_MCP_OAUTH are "true" and otherwise stays up as a
  // health-only app (WP-M5); the API and web ignore it.
  ORBIT_MCP_TASKS: z.enum(["false", "true"]).default("false"),
  ORBIT_MCP_GATEWAY: z.enum(["false", "true"]).default("false"),
  // Port of the gateway process; the reverse proxy routes /mcp to it.
  MCP_PORT: unset(z.coerce.number().int().min(1).max(65535).default(4312)),
  // Where the gateway fetches the token signing keys (the API's Better Auth
  // JWKS). Empty = `${APP_ORIGIN}/api/auth/jwks`; compose sets the internal
  // http://api:4311/api/auth/jwks so verification does not leave the network.
  // Only http(s) URLs are accepted.
  MCP_JWKS_URL: unset(z.url({ protocol: /^https?$/ }).optional()),
  // Browser origins allowed to call the gateway (comma list); empty allows none.
  ORBIT_MCP_ALLOWED_ORIGINS: unset(z.string().default("")),
  // Central switch for MCP proposal tools (Track M, WP-M4): while "false" the
  // gateway neither lists nor runs a P_proposal tool. Status polling stays.
  ORBIT_MCP_PROPOSALS: unset(z.enum(["false", "true"]).default("false")),
  // Module-level roles (WP4.5): off until the security review and approval.
  ORBIT_MODULE_ROLES: z.enum(["false", "true"]).default("false"),
  // Public ingress (WP4.2): signed provider webhooks; off until the security review.
  ORBIT_PUBLIC_INGRESS: z.enum(["false", "true"]).default("false"),
  // Support module (WP5.1): off until the pilot is approved. Even when "true",
  // support works only in projects whose owner enabled the module.
  ORBIT_SUPPORT: z.enum(["false", "true"]).default("false"),
  // Platform files (WP4.6): an own S3-compatible bucket (R2), never the
  // backup bucket or its credentials. Off until the security review.
  ORBIT_FILES: z.enum(["false", "true"]).default("false"),
  // Where file content lives: encrypted rows in Postgres (with the database
  // backup; Mario's choice for the pilot) or an S3-compatible bucket.
  FILES_BACKEND: z.enum(["database", "s3"]).default("database"),
  FILES_S3_ENDPOINT: unset(z.url().optional()),
  FILES_S3_BUCKET: unset(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
      .optional(),
  ),
  FILES_S3_REGION: z.string().min(1).default("auto"),
  FILES_S3_ACCESS_KEY_ID: unset(z.string().min(1).optional()),
  FILES_S3_SECRET_ACCESS_KEY: unset(z.string().min(1).optional()),
  // 32 bytes as hex, separate from CREDENTIAL_KEY.
  FILES_ENCRYPTION_KEY: unset(
    z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
  ),
  // E-mail over SMTP/IMAP and member notifications (WP4.7); off until the
  // security review. Sending also needs EXECUTION_MODE=live and external writes.
  ORBIT_EMAIL: z.enum(["false", "true"]).default("false"),
  // In-app member notifications and their preferences (WP4.7).
  ORBIT_NOTIFICATIONS: z.enum(["false", "true"]).default("false"),
  // Real-time fan-out (WP4.3 Part B): writers publish committed changes over
  // Redis and the chat SSE route waits for them instead of polling the
  // database. Off keeps the 700 ms polling route. The API and the worker
  // need the same value.
  ORBIT_REALTIME: z.enum(["false", "true"]).default("false"),
  FILES_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(50 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  // What one project may store in all (WP4.6 review). With the database
  // backend the files are in every backup, whose work space is a 512 MB
  // tmpfs holding the dump and its encrypted copy: keep the sum of all
  // projects and the rest of the database below about 250 MB until the
  // backup works on disk.
  FILES_PROJECT_QUOTA_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1024 * 1024 * 1024 * 1024)
    .default(100 * 1024 * 1024),
});
export const configSchema = baseConfigSchema.transform((config, ctx) => {
  // Normalized once here, so the advertised resource, the token audience and
  // every comparison Orbit makes use the same spelling.
  const MCP_RESOURCE = normalizeMcpResource(
    config.MCP_RESOURCE ?? `${new URL(config.APP_ORIGIN).origin}/mcp`,
  );
  // A derived default only has to be valid when the OAuth server is switched on,
  // so a plain-http APP_ORIGIN keeps booting with the flag off.
  if (config.ORBIT_MCP_OAUTH === "true" && !isValidMcpResource(MCP_RESOURCE)) {
    ctx.addIssue({
      code: "custom",
      path: ["MCP_RESOURCE"],
      message:
        "MCP_RESOURCE (default APP_ORIGIN + /mcp) must be https or loopback http when ORBIT_MCP_OAUTH is true",
    });
    return z.NEVER;
  }
  return { ...config, MCP_RESOURCE };
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(): Config {
  return configSchema.parse(process.env);
}
