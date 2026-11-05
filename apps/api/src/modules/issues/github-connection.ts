import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import {
  GITHUB_APP_PROVIDER,
  GITHUB_ISSUES_PURPOSE,
  installationRepositories,
  parseGithubAppSecret,
  type GithubAppSecret,
  type GithubRepository,
} from "../../platform/connections/github-app.ts";
import {
  connectionSecret,
  resolveConnection,
} from "../../platform/connections/central.ts";
import { DomainError } from "../../shared.ts";
import { readIssuesSettings, type IssuesSettings } from "./settings.ts";

// The project's GitHub App connection and repository allow-list (slice 1).
// The secret is read only right before a provider call and never returned.

/** The granted GitHub App of the project, with its secret. */
export async function githubApp(
  tx: DbTx,
  scope: Scope,
): Promise<{ connectionId: string; app: GithubAppSecret }> {
  const granted = await resolveConnection(tx, scope, {
    provider: GITHUB_APP_PROVIDER,
    purpose: GITHUB_ISSUES_PURPOSE,
    module: "issues",
  });
  const raw = granted ? await connectionSecret(tx, granted.connection.id) : null;
  if (!granted || !raw) throw new DomainError("ISSUES_GITHUB_NOT_CONNECTED", 409);
  return { connectionId: granted.connection.id, app: parseGithubAppSecret(raw) };
}

/** The allow-listed repository for a key, or 409. */
export function allowedRepository(settings: IssuesSettings, key: string) {
  const found = settings.github.repositories.find((r) => r.key === key);
  if (!found) throw new DomainError("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED", 409);
  return found;
}

/** The first of the components whose repository is an allow-list key. */
export function componentRepository(
  settings: IssuesSettings,
  components: string[],
): string | null {
  for (const component of components) {
    const key = settings.components.find((c) => c.key === component)?.repository;
    if (key && settings.github.repositories.some((r) => r.key === key)) return key;
  }
  return null;
}

const codeOf = (error: unknown) =>
  error instanceof DomainError ? error.code : "GITHUB_REQUEST_FAILED";

type StoredStatus =
  | { connected: false; repositories: IssuesSettings["github"]["repositories"] }
  | {
      connected: true;
      error: string;
      repositories: IssuesSettings["github"]["repositories"];
    }
  | {
      connected: true;
      account: string;
      app: GithubAppSecret;
      repositories: IssuesSettings["github"]["repositories"];
    };

/**
 * Step 1 of the status, inside the project transaction: the allow-list, the
 * grant and the secret. It calls no provider.
 */
export async function githubStoredStatus(tx: DbTx, scope: Scope): Promise<StoredStatus> {
  const { settings } = await readIssuesSettings(tx, scope);
  const repositories = settings.github.repositories;
  try {
    const { app } = await githubApp(tx, scope);
    return { connected: true, account: app.appSlug, app, repositories };
  } catch (error) {
    if (error instanceof DomainError && error.code === "ISSUES_GITHUB_NOT_CONNECTED")
      return { connected: false, repositories };
    // A stored secret that no longer parses: connected, but unusable.
    return { connected: true, error: codeOf(error), repositories };
  }
}

/**
 * Step 2, after the transaction closed: the connection state and the
 * allow-list, plus the installation's repositories only when the caller
 * asks for them (the settings picker). GitHub failures come back as `error`;
 * the secret never leaves this function.
 */
export async function githubStatus(stored: StoredStatus, options: { available: boolean }) {
  if (!stored.connected || "error" in stored) return stored;
  const { account, repositories } = stored;
  if (!options.available) return { connected: true as const, account, repositories };
  try {
    const available = (await installationRepositories(stored.app)).map(
      ({ fullName, private: isPrivate, archived }) => ({
        fullName,
        private: isPrivate,
        archived,
      }),
    );
    return { connected: true as const, account, repositories, available };
  } catch (error) {
    return { connected: true as const, account, error: codeOf(error), repositories };
  }
}

/** Repositories of the allow-list that are not yet stored. */
export const newRepositories = (
  next: IssuesSettings,
  stored: IssuesSettings,
) => {
  const known = new Set(stored.github.repositories.map((r) => r.fullName));
  return next.github.repositories.filter((r) => !known.has(r.fullName));
};

/** Throws unless each fullName is a private, unarchived installation repository. */
export function checkAvailable(
  fullNames: string[],
  available: GithubRepository[],
) {
  const byName = new Map(available.map((r) => [r.fullName.toLowerCase(), r]));
  for (const name of fullNames) {
    const found = byName.get(name.toLowerCase());
    if (!found || found.private !== true || found.archived)
      throw new DomainError("ISSUES_GITHUB_REPOSITORY_NOT_ALLOWED", 409);
  }
}
