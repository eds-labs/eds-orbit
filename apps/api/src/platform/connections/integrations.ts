// Uniform integration state for the Integrations Center. Pure and I/O free: the
// existing status vocabularies (central connections, project connectors, social
// accounts, Drive, Telegram, installation items) are mapped to six states on the
// server so the UI never has to interpret provider-specific strings.

import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";

export const INTEGRATION_STATES = ["not_set_up", "stored", "verified", "ready", "needs_attention", "disabled"] as const;
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

export const INTEGRATION_CATEGORIES = ["email", "social", "google", "ai", "automation", "mcp", "development", "analytics", "other"] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

export const INTEGRATION_AUTH_TYPES = ["api_key", "json_secret", "oauth_app", "oauth_account", "bot_token", "password", "webhook_secret", "environment"] as const;
export type IntegrationAuthType = (typeof INTEGRATION_AUTH_TYPES)[number];

export type IntegrationStorage = "central" | "project" | "environment";

/** An integration outside the provider registry, contributed by its owner. */
export type IntegrationDescriptor = {
  /** /^[a-z][a-z0-9_.]{1,63}$/, unique across descriptors and provider ids. */
  id: string;
  label: { en: string; de: string };
  category: IntegrationCategory;
  authType: IntegrationAuthType;
  /** Owner scopes, as for providers; [] for environment-only items. */
  scopes: ReadonlyArray<"system" | "workspace" | "project">;
  storage: readonly IntegrationStorage[];
  checkable: boolean;
  /** Default: always available (the owner module's availability still applies). */
  available?: () => boolean;
};

/** One project-level record a module lists; the platform adds category and group. */
export type ContributedIntegration = {
  id: string;
  provider: string;
  label: string;
  scope: "central" | "project";
  state: IntegrationState;
  checkedAt: string | null;
};

/** Runs in the project's read transaction with the member's role in the module. */
export type ProjectIntegrationsContribution = (
  tx: DbTx,
  scope: Scope,
) => Promise<ContributedIntegration[]>;

export type StateSource =
  | {
      kind: "central";
      status: string;
      disabled: boolean;
      revoked: boolean;
      /** "none": read without a consuming organization or project. */
      grant: "none" | "active" | "revoked";
      binding: "not_needed" | "missing" | "present";
    }
  | { kind: "project_connector"; status: string | null }
  | { kind: "social_account"; status: string; capability: string }
  | { kind: "drive"; connected: boolean; reconnectRequired: boolean; rootConfigured: boolean }
  | { kind: "telegram"; status: "none" | "pending" | "linked" | "disabled" }
  | { kind: "installation"; configured: boolean; installed: boolean };

const isVerified = (status: string) => status === "read_verified" || status === "write_verified";

// Rules apply top to bottom within a kind; a failed, revoked or disabled record
// must never reach "ready".
export function integrationState(source: StateSource): IntegrationState {
  switch (source.kind) {
    case "central":
      if (source.revoked || source.disabled) return "disabled";
      if (source.grant === "revoked") return "disabled";
      if (source.status === "failed") return "needs_attention";
      if (!isVerified(source.status)) return "stored";
      if (source.grant === "none") return "verified";
      return source.binding === "missing" ? "verified" : "ready";
    case "project_connector":
      if (!source.status) return "not_set_up";
      if (source.status === "revoked" || source.status === "disabled") return "disabled";
      if (source.status === "failed") return "needs_attention";
      return isVerified(source.status) ? "ready" : "stored";
    case "social_account":
      if (source.status === "disabled") return "disabled";
      if (source.status === "reconnect_required") return "needs_attention";
      if (source.status === "active") return source.capability === "write_verified" ? "ready" : "verified";
      return "stored";
    case "drive":
      if (!source.connected) return "not_set_up";
      if (source.reconnectRequired) return "needs_attention";
      return source.rootConfigured ? "ready" : "verified";
    case "telegram":
      switch (source.status) {
        case "pending": return "stored";
        case "linked": return "verified";
        case "disabled": return "disabled";
        default: return "not_set_up";
      }
    case "installation":
      if (source.installed) return "ready";
      return source.configured ? "stored" : "not_set_up";
  }
}
