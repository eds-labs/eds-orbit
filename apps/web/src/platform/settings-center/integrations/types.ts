// Mirror of the integration shapes of apps/api (connections/integrations.ts,
// management/integration-catalog.ts, project-integrations.ts,
// organization-integrations.ts, administration/environment-status.ts). The web
// app never imports server code, so they are copied by hand; types.test.tsx
// fails when the value lists drift.

export const INTEGRATION_STATES = ["not_set_up", "stored", "verified", "ready", "needs_attention", "disabled"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const INTEGRATION_CATEGORIES = ["email", "social", "google", "ai", "automation", "mcp", "development", "analytics", "other"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_AUTH_TYPES = ["api_key", "json_secret", "oauth_app", "oauth_account", "bot_token", "password", "webhook_secret", "environment"] as const;
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number];

export type IntegrationStorage = "central" | "project" | "environment";

export type CatalogEntry = {
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  scopes: Array<"system" | "workspace" | "project">;
  checkable: boolean;
  storage: IntegrationStorage[];
  available: boolean;
  /** "platform" or the module id. */
  owner: string;
};

export type ProjectIntegration = {
  id: string;
  provider: string;
  label: string;
  category: IntegrationCategory;
  scope: "central" | "project";
  state: IntegrationState;
  checkedAt: string | null;
  /** The mail server host of a mailbox (D-5 grouping); null otherwise. */
  group: string | null;
};

export type OrganizationIntegrations = {
  connections: Array<{
    id: string;
    provider: string;
    label: string;
    category: IntegrationCategory;
    scope: "system" | "workspace";
    state: IntegrationState;
    checkedAt: string | null;
    /** Projects of this organization holding an active grant of it. */
    projects: Array<{ id: string; name: string; bound: boolean }>;
  }>;
  projects: Array<{ id: string; name: string; integrations: ProjectIntegration[] }>;
};

export type EnvironmentStatus = {
  redis: { configured: boolean; reachable: boolean };
  files: { configured: boolean };
  googleDriveApp: { configured: boolean };
  aiFallbackKeys: { openai: boolean; anthropic: boolean };
  credentialKeys: { ring: boolean };
  mcp: {
    oauth: boolean;
    gateway: boolean;
    dcr: boolean;
    tasks: boolean;
    proposals: boolean;
    projectConfiguration: boolean;
    projectAdministration: boolean;
  };
  connectionsCutover: string[];
};

/** One record shown on a card. */
export type CardRecord = {
  key: string;
  label: string;
  state: IntegrationState;
  checkedAt: string | null;
  detail?: string;
};
