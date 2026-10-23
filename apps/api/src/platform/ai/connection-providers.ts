import {
  boundedFetch,
  ConnectorError,
  type FetchLike,
} from "../../../../../packages/connectors/src/index.ts";
import { DomainError } from "../shared.ts";
import type { ConnectionProvider } from "../connections/connections.ts";

// OpenAI and Anthropic accounts as central connections (ADR 0014). The
// check lists the account's models: no paid call, no prompt, and only the
// count of visible models is kept.

let fetcher: FetchLike = boundedFetch;
/** Tests replace the transport; null restores the bounded one. */
export function setAiCheckFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

async function listModels(url: string, headers: Record<string, string>) {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new DomainError(
      error instanceof ConnectorError ? error.code : "PROVIDER_UNREACHABLE",
      409,
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new DomainError("PROVIDER_KEY_REJECTED", 409);
  if (!response.ok) throw new DomainError("PROVIDER_CHECK_FAILED", 409);
  const body = (await response.json().catch(() => null)) as {
    data?: unknown[];
  } | null;
  return { status: "read_verified", models: body?.data?.length ?? 0 };
}

export const openAiConnectionProvider: ConnectionProvider = {
  scopes: ["system", "workspace"],
  // Embeddings use the text key, as they always have.
  purposes: ["text", "image"],
  label: { en: "OpenAI", de: "OpenAI" },
  check: (_connection, key) =>
    listModels("https://api.openai.com/v1/models", {
      authorization: `Bearer ${key}`,
    }),
};

export const anthropicConnectionProvider: ConnectionProvider = {
  scopes: ["system", "workspace"],
  purposes: ["text"],
  label: { en: "Anthropic Claude", de: "Anthropic Claude" },
  check: (_connection, key) =>
    listModels("https://api.anthropic.com/v1/models", {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
};
