import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  scoped,
} from "../../../../../packages/db/src/index.ts";
import { loadConfig } from "../../../../../packages/config/src/index.ts";
import {
  boundedFetch,
  ConnectorError,
  type FetchLike,
} from "../../../../../packages/connectors/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { create, data, DomainError, entity, list, update } from "../shared.ts";
import type { ConnectionProvider } from "../connections/connections.ts";
import { connectionSecret, grantedConnections } from "../connections/central.ts";
import { liveSending } from "../email/connection.ts";

// An automation layer such as n8n as a central connection (ADR 0014,
// WP3.7). Orbit triggers a bound workflow with a signed, product-neutral
// request (contract automation.v1) and receives its outcome through a
// signed callback; product mappings (FamilyPlan, uLiquid Desk …) stay in
// the workflows. A project may trigger a binding only while it holds a
// grant of the binding's connection with purpose "automation". Runs keep
// status and codes, never a payload.

export const AUTOMATION_PURPOSE = "automation";
const RUN_KIND = "workflow_runs";
const SKEW_SECONDS = 300;
const MAX_PAYLOAD = 16 * 1024;

let fetcher: FetchLike = boundedFetch;
/** Tests replace the transport; null restores the bounded one. */
export function setAutomationFetchForTests(next: FetchLike | null) {
  fetcher = next ?? boundedFetch;
}

const secretShape = z
  .object({
    apiKey: z.string().min(8).max(500),
    signingSecret: z.string().min(32).max(500),
  })
  .strict();
const secretOf = (plain: string) => {
  try {
    return secretShape.parse(JSON.parse(plain));
  } catch {
    throw new DomainError("AUTOMATION_SECRET_INVALID", 409);
  }
};

const https = (value: unknown) => {
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.username || url.password || url.search)
    throw new DomainError("HTTPS_REQUIRED", 400);
  return url.toString().replace(/\/$/, "");
};

/** `v1=<hex HMAC-SHA256(secret, timestamp + "." + body)>`, as customer context. */
export function signAutomationBody(secret: string, timestamp: string, body: string) {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * The n8n connection: the instance URL; the secret is the JSON
 * {apiKey, signingSecret}. The check reads one workflow page with the API
 * key (no execution, nothing kept but the status).
 */
export const n8nConnectionProvider: ConnectionProvider = {
  scopes: ["system", "workspace"],
  purposes: [AUTOMATION_PURPOSE],
  label: { en: "n8n", de: "n8n" },
  normalizeCentral: (fields) => ({ baseUrl: https(fields.baseUrl) }),
  async check(connection, plain) {
    const { apiKey } = secretOf(plain);
    let response: Response;
    try {
      response = await fetcher(`${https(connection.baseUrl)}/api/v1/workflows?limit=1`, {
        method: "GET",
        headers: { "X-N8N-API-KEY": apiKey, accept: "application/json" },
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
    return { status: "read_verified" };
  },
};

/** A binding this project may trigger, with its granted connection. */
async function usableBinding(
  tx: Parameters<Parameters<typeof scoped>[2]>[0],
  scope: Pick<Scope, "workspaceId" | "projectId">,
  bindingId: string,
) {
  const binding = await tx.workflowBinding.findFirst({
    where: { id: z.uuid().parse(bindingId), revokedAt: null },
  });
  if (!binding) throw new DomainError("NOT_FOUND", 404);
  const granted = (
    await grantedConnections(tx, scope, { purpose: AUTOMATION_PURPOSE })
  ).find((g) => g.connection.id === binding.connectionId);
  if (!granted) throw new DomainError("NOT_FOUND", 404);
  return { binding, granted };
}

/** The workflows this project may trigger (labels and contracts only). */
export async function projectBindings(scope: Scope) {
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const granted = await grantedConnections(tx, scope, {
      purpose: AUTOMATION_PURPOSE,
    });
    const bindings = await tx.workflowBinding.findMany({
      where: {
        revokedAt: null,
        connectionId: { in: granted.map((g) => g.connection.id) },
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      items: bindings.map((b) => ({
        id: b.id,
        label: b.label,
        contract: b.contract,
        connection: granted.find((g) => g.connection.id === b.connectionId)!
          .connection.label,
      })),
    };
  });
}

export const triggerInput = z
  .object({
    bindingId: z.uuid(),
    event: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * Triggers a bound workflow for the project. Outside live mode with
 * external writes nothing is sent and the run ends as a test receipt.
 */
export async function triggerWorkflow(scope: Scope, raw: unknown) {
  const input = triggerInput.parse(raw);
  const body = JSON.stringify(input.payload);
  if (Buffer.byteLength(body) > MAX_PAYLOAD)
    throw new DomainError("PAYLOAD_TOO_LARGE", 400);
  const prepared = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const { binding, granted } = await usableBinding(tx, scope, input.bindingId);
    const plain = await connectionSecret(tx, granted.connection.id);
    if (!plain) throw new DomainError("CONNECTION_NOT_GRANTED", 409);
    const secret = secretOf(plain);
    const requestId = randomUUID();
    const run = await create(tx, scope, RUN_KIND, {
      bindingId: binding.id,
      contract: binding.contract,
      event: input.event,
      requestId,
      status: "sending",
      startedAt: new Date().toISOString(),
      requestedBy: scope.userId,
    });
    const baseUrl = https(granted.connection.config.baseUrl);
    return {
      run,
      url: `${baseUrl}/webhook/${binding.workflowRef}`,
      signingSecret: secret.signingSecret,
      payload: JSON.stringify({
        contract: "automation.v1",
        requestId,
        runId: run.id,
        event: input.event,
        payload: input.payload,
        callbackUrl: `${new URL(loadConfig().APP_ORIGIN).origin}/api/automation/callbacks/${scope.projectId}/${run.id}`,
      }),
    };
  });
  let outcome: Record<string, unknown>;
  if (!liveSending()) outcome = { status: "test_receipt" };
  else {
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetcher(prepared.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Orbit-Timestamp": timestamp,
          "X-Orbit-Request-Id": data(prepared.run).requestId,
          "X-Orbit-Signature": signAutomationBody(prepared.signingSecret, timestamp, prepared.payload),
        },
        body: prepared.payload,
        signal: AbortSignal.timeout(10_000),
      });
      const answer = (await response.json().catch(() => null)) as {
        executionId?: unknown;
      } | null;
      outcome = response.ok
        ? {
            status: "accepted",
            ...(typeof answer?.executionId === "string" || typeof answer?.executionId === "number"
              ? { executionId: String(answer.executionId).slice(0, 64) }
              : {}),
          }
        : { status: "failed", errorCode: `HTTP_${response.status}` };
    } catch (error) {
      outcome =
        error instanceof ConnectorError && error.outcome === "not_sent"
          ? { status: "failed", errorCode: error.code }
          : { status: "outcome_unknown", errorCode: "NO_ANSWER" };
    }
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const current = await entity(tx, scope, RUN_KIND, prepared.run.id);
    const done = await update(tx, scope, current, {
      ...data(current),
      ...outcome,
      ...(outcome.status === "accepted" ? {} : { finishedAt: new Date().toISOString() }),
    });
    return publicRun(done);
  });
}

function publicRun(row: { id: string; data: unknown; createdAt: Date }) {
  const d = row.data as Record<string, unknown>;
  return {
    id: row.id,
    bindingId: d.bindingId,
    event: d.event,
    status: d.status,
    errorCode: d.errorCode ?? null,
    executionId: d.executionId ?? null,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt ?? null,
  };
}

export async function listRuns(scope: Scope) {
  const rows = await scoped(scope.workspaceId, scope.projectId, (tx) =>
    list(tx, scope, RUN_KIND),
  );
  return { items: rows.slice(0, 100).map(publicRun) };
}

const callbackBody = z
  .object({
    status: z.enum(["completed", "failed"]),
    executionId: z.union([z.string().max(64), z.number()]).optional(),
    errorCode: z.string().regex(/^[A-Z0-9_]{1,64}$/).optional(),
  })
  .strict();

/**
 * A workflow's signed outcome. The signature uses the binding's
 * connection secret as the project still holds it: a revoked grant makes
 * every later callback fail. Answers 404 for anything that does not check
 * out, without saying why.
 */
export async function receiveCallback(
  projectId: string,
  runId: string,
  headers: Record<string, unknown>,
  raw: string,
) {
  const project = await authDb.project.findUnique({
    where: { id: z.uuid().parse(projectId) },
    select: { workspaceId: true },
  });
  if (!project) throw new DomainError("NOT_FOUND", 404);
  const scope = { workspaceId: project.workspaceId, projectId } as Scope;
  const timestamp = String(headers["x-orbit-timestamp"] ?? "");
  const signature = String(headers["x-orbit-signature"] ?? "");
  if (
    !/^\d{9,11}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > SKEW_SECONDS
  )
    throw new DomainError("NOT_FOUND", 404);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const run = await tx.entity.findFirst({
      where: { id: z.uuid().parse(runId), projectId, kind: RUN_KIND },
    });
    if (!run) throw new DomainError("NOT_FOUND", 404);
    const d = data(run);
    const { granted } = await usableBinding(tx, scope, String(d.bindingId)).catch(() => {
      throw new DomainError("NOT_FOUND", 404);
    });
    const plain = await connectionSecret(tx, granted.connection.id);
    if (!plain) throw new DomainError("NOT_FOUND", 404);
    const expected = signAutomationBody(secretOf(plain).signingSecret, timestamp, raw);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new DomainError("NOT_FOUND", 404);
    let parsed: z.infer<typeof callbackBody>;
    try {
      parsed = callbackBody.parse(JSON.parse(raw));
    } catch {
      throw new DomainError("VALIDATION_FAILED", 400);
    }
    // A finished run stays finished: replays change nothing.
    if (["completed", "failed"].includes(String(d.status)))
      return { accepted: true, unchanged: true };
    await update(tx, scope, run, {
      ...d,
      status: parsed.status,
      ...(parsed.executionId !== undefined ? { executionId: String(parsed.executionId) } : {}),
      ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
      finishedAt: new Date().toISOString(),
    });
    return { accepted: true };
  });
}

/**
 * The execution's state from n8n's API, on demand: status and times only,
 * never its data.
 */
export async function executionStatus(scope: Scope, runId: string) {
  const prepared = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const run = await entity(tx, scope, RUN_KIND, z.uuid().parse(runId));
    const d = data(run);
    if (!d.executionId) throw new DomainError("EXECUTION_UNKNOWN", 409);
    const { granted } = await usableBinding(tx, scope, String(d.bindingId));
    const plain = await connectionSecret(tx, granted.connection.id);
    if (!plain) throw new DomainError("CONNECTION_NOT_GRANTED", 409);
    return {
      url: `${https(granted.connection.config.baseUrl)}/api/v1/executions/${encodeURIComponent(String(d.executionId))}?includeData=false`,
      apiKey: secretOf(plain).apiKey,
    };
  });
  let response: Response;
  try {
    response = await fetcher(prepared.url, {
      method: "GET",
      headers: { "X-N8N-API-KEY": prepared.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DomainError("PROVIDER_UNREACHABLE", 409);
  }
  if (!response.ok) throw new DomainError(`HTTP_${response.status}`, 409);
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: typeof body.status === "string" ? body.status : null,
    finished: body.finished === true,
    startedAt: typeof body.startedAt === "string" ? body.startedAt : null,
    stoppedAt: typeof body.stoppedAt === "string" ? body.stoppedAt : null,
  };
}
