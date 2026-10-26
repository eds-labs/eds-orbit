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
  ORBIT_KNOWLEDGE_WORKSPACE: z.enum(["false", "true"]).default("false"),
  ORBIT_AGENTS: z.enum(["false", "true"]).default("false"),
  // The owner's Telegram bot (ADR 0015): a platform switch of its own.
  // Unset, it follows the modules as before (on with Orbit Agents).
  ORBIT_TELEGRAM: unset(z.enum(["false", "true"]).optional()),
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
  // Project configuration over MCP (plans/project-configuration-mcp.md): the
  // read tool, and the owner-approved update (which also needs proposals).
  ORBIT_MCP_PROJECT_CONFIGURATION: unset(
    z.enum(["false", "true"]).default("false"),
  ),
  // Project administration over MCP (docs/MCP_PROJECT_ADMINISTRATION.md):
  // Marketing policy, AI models, integrations, knowledge evaluation and
  // readiness; changes also need proposals and an owner's approval.
  ORBIT_MCP_PROJECT_ADMINISTRATION: unset(
    z.enum(["false", "true"]).default("false"),
  ),
  // AI key rule (plan decision E-1b): "true" uses an environment key only
  // for a project without saved AI settings, for every provider. "false"
  // keeps the rule of before (the Anthropic environment key always applies).
  ORBIT_AI_KEY_RULE_V2: z.enum(["false", "true"]).default("false"),
  // Central AI price catalog (plans/ai-central-management.md, phase A): every
  // active catalog model is verified and priced for every project, under the
  // project's own settings. Read directly from the environment by the API.
  ORBIT_AI_CATALOG: z.enum(["false", "true"]).default("false"),
  // Organization standard models and project presets (phase B); apply only
  // while the catalog is on too. Read directly from the environment.
  ORBIT_AI_DEFAULTS: z.enum(["false", "true"]).default("false"),
  // Organization AI budget and provider caps (phase C): every reservation
  // adds to the organization's month counters, checked against its budget.
  ORBIT_AI_ORG_BUDGET: z.enum(["false", "true"]).default("false"),
  // Where the AI spending authority is read from (ADR 0015, plan 3.8):
  // "platform" only the platform record (no paid AI without one);
  // "fallback" the platform record, else the Marketing policy's budget
  // fields (the transition, first rollback level); "marketing" only the
  // Marketing policy, as before ADR 0015.
  ORBIT_SPEND_POLICY_SOURCE: z
    .enum(["platform", "fallback", "marketing"])
    .default("platform"),
  // Module-level roles (WP4.5): off until the security review and approval.
  ORBIT_MODULE_ROLES: z.enum(["false", "true"]).default("false"),
  // Public ingress (WP4.2): signed provider webhooks; off until the security review.
  ORBIT_PUBLIC_INGRESS: z.enum(["false", "true"]).default("false"),
  // Marketing module for the whole installation (ADR 0015, E-7). On by
  // default, as before; "false" removes it everywhere like ORBIT_SUPPORT does.
  ORBIT_MARKETING: z.enum(["false", "true"]).default("true"),
  // Support module (WP5.1): off until the pilot is approved. Even when "true",
  // support works only in projects whose owner enabled the module.
  ORBIT_SUPPORT: z.enum(["false", "true"]).default("false"),
  // Finance module: off until its rollout is approved. Even when "true",
  // finance works only in projects whose owner enabled the module.
  ORBIT_FINANCE: z.enum(["false", "true"]).default("false"),
  // Project management module (ADR 0016): off until its rollout is approved.
  // Even when "true", it works only in projects whose owner enabled it.
  ORBIT_WORK: z.enum(["false", "true"]).default("false"),
  // AI project manager (ADR 0017): off until its rollout is approved; needs
  // ORBIT_WORK and the module in the project as well.
  ORBIT_WORK_PM: z.enum(["false", "true"]).default("false"),
  // Issue center (ADR 0018): off until its rollout is approved. Even when
  // "true", it works only in projects whose owner enabled the module.
  ORBIT_ISSUES: z.enum(["false", "true"]).default("false"),
  // Universal customer context (ADR 0011): live, read-only account facts
  // from external products for Support. Off until a provider passed its
  // integration test; each inbox must still be bound by its owner.
  ORBIT_CUSTOMER_CONTEXT: z.enum(["false", "true"]).default("false"),
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
  // System administration, organization settings and invitations
  // (ADR 0013). Off returns 404 for /api/admin, /api/organizations and
  // /api/invitations.
  ORBIT_ADMINISTRATION: z.enum(["false", "true"]).default("false"),
  // Account self-service: profile, password, sessions, password reset and
  // e-mail change (ADR 0013). Off returns 404 for /api/account.
  ORBIT_ACCOUNT: z.enum(["false", "true"]).default("false"),
  // Central connections, AI profiles and organization knowledge shares
  // (ADR 0014). Off: the routes answer 404 and the runtime ignores central
  // connections, so every project keeps using its own settings.
  ORBIT_CONNECTIONS: z.enum(["false", "true"]).default("false"),
  // Organization knowledge libraries shared with projects (ADR 0014, E1).
  // Off: shares are ignored and their routes answer 404.
  ORBIT_KNOWLEDGE_SHARES: z.enum(["false", "true"]).default("false"),
  // Providers whose project connections may use a granted central
  // connection instead of their own key (ADR 0014, WP3.4), comma-separated,
  // e.g. "postiz,matomo". A project connection keeps its own key until it is
  // bound; removing a provider here makes bound connections fail closed and
  // adopted ones fall back to their kept key.
  ORBIT_CONNECTIONS_CUTOVER: unset(
    z
      .string()
      .regex(/^[a-z_]+(,[a-z_]+)*$/)
      .optional(),
  ),
  // Optional master-key ring for connection secrets: "id:hex64,id:hex64",
  // newest first. New secrets use the first key; CREDENTIAL_KEY stays
  // readable as key id "default".
  CREDENTIAL_KEYS: unset(
    z
      .string()
      .regex(/^[a-z0-9_-]{1,32}:[a-fA-F0-9]{64}(,[a-z0-9_-]{1,32}:[a-fA-F0-9]{64})*$/)
      .optional(),
  ),
  // System authentication mail (invitations, password reset), independent of
  // any project mailbox (ADR 0013, amends Q-16). Unset host or sender means
  // "not configured": administrators then copy links by hand. Sending also
  // needs EXECUTION_MODE=live and external writes.
  ORBIT_SYSTEM_SMTP_HOST: unset(z.string().min(1).max(253).optional()),
  ORBIT_SYSTEM_SMTP_PORT: unset(
    z.coerce.number().int().min(1).max(65535).default(587),
  ),
  ORBIT_SYSTEM_SMTP_TLS: unset(
    z.enum(["implicit", "starttls"]).default("starttls"),
  ),
  ORBIT_SYSTEM_SMTP_USER: unset(z.string().min(1).optional()),
  ORBIT_SYSTEM_SMTP_PASSWORD: unset(z.string().min(1).optional()),
  ORBIT_SYSTEM_SMTP_FROM: unset(z.email().optional()),
  ORBIT_SYSTEM_SMTP_FROM_NAME: unset(z.string().min(1).max(100).default("Orbit")),
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
