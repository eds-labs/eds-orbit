import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  createSlackClient,
  verifySlackInteraction,
  ConnectorError,
  type FetchLike,
} from "../../../../packages/connectors/src/index.ts";
import {
  data,
  entity,
  list,
  create,
  update,
  encrypt,
  decrypt,
  hash,
  audit,
  exception,
  DomainError,
  publicEntity,
} from "../shared.ts";
import { preflight, approve } from "./policy.ts";
import { enqueue } from "./workflow.ts";

const slackId = z.string().regex(/^[A-Z][A-Z0-9]{2,39}$/);
export const slackConfiguration = z
  .object({
    botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,500}$/),
    signingSecret: z.string().regex(/^[a-fA-F0-9]{32,128}$/),
    teamId: slackId.refine((v) => v.startsWith("T")),
    channelId: slackId.refine((v) => /^[CG]/.test(v)),
    confirmChannelMandate: z.literal(true),
    allowApprovals: z.boolean().default(false),
    validUntil: z.iso.datetime(),
    actors: z
      .array(z.object({ slackUserId: slackId, orbitUserId: z.uuid() }).strict())
      .min(1)
      .max(30),
  })
  .strict();
export type SlackConfiguration = z.input<typeof slackConfiguration>;
const privateCredentials = z
  .object({ botToken: z.string(), signingSecret: z.string() })
  .strict();

async function isOwner(
  scope: Pick<Scope, "workspaceId" | "projectId">,
  userId: string,
) {
  const project = await authDb.project.findFirst({
    where: {
      id: scope.projectId,
      workspaceId: scope.workspaceId,
      OR: [
        { workspace: { members: { some: { userId, role: "owner" } } } },
        { members: { some: { userId, role: "owner" } } },
      ],
    },
    select: { id: true },
  });
  return !!project;
}
function owner(scope: Scope) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
}
function credentials(c: ReturnType<typeof data>) {
  try {
    return privateCredentials.parse(
      JSON.parse(decrypt(c.encryptedCredential, process.env.CREDENTIAL_KEY!)),
    );
  } catch {
    throw new DomainError("SLACK_CREDENTIAL_CONFIGURATION_REQUIRED", 409);
  }
}
function mandate(c: ReturnType<typeof data>, at = new Date()) {
  if (
    c.provider !== "slack" ||
    c.confirmChannelMandate !== true ||
    !["configured", "write_verified"].includes(c.status) ||
    !c.teamId ||
    !c.channelId ||
    !Array.isArray(c.actors) ||
    !(new Date(c.validUntil) > at)
  )
    throw new DomainError("SLACK_CHANNEL_MANDATE_REQUIRED", 409);
}
async function selectedConnector(tx: DbTx, scope: Scope) {
  const c = (await list(tx, scope, "connectors")).find(
    (x) =>
      data(x).provider === "slack" &&
      data(x).confirmChannelMandate === true &&
      data(x).status !== "revoked",
  );
  if (!c) throw new DomainError("SLACK_NOT_CONFIGURED", 409);
  mandate(data(c));
  return c;
}

/** Owner-only configuration grants exactly one team/channel; it sends nothing. */
export async function configureSlack(
  tx: DbTx,
  scope: Scope,
  raw: SlackConfiguration,
) {
  owner(scope);
  const input = slackConfiguration.parse(raw);
  if (
    Date.parse(input.validUntil) <= Date.now() ||
    Date.parse(input.validUntil) > Date.now() + 90 * 86400_000 ||
    new Set(input.actors.map((x) => x.slackUserId)).size !== input.actors.length
  )
    throw new DomainError("INVALID_SLACK_MANDATE");
  for (const actor of input.actors)
    if (!(await isOwner(scope, actor.orbitUserId)))
      throw new DomainError("SLACK_ACTOR_MUST_BE_PROJECT_OWNER", 403);
  for (const previous of await list(tx, scope, "connectors"))
    if (
      data(previous).provider === "slack" &&
      data(previous).confirmChannelMandate
    )
      await update(tx, scope, previous, {
        ...data(previous),
        status: "revoked",
      });
  const { botToken, signingSecret, ...metadata } = input;
  const c = await create(tx, scope, "connectors", {
    ...metadata,
    provider: "slack",
    encryptedCredential: encrypt(
      JSON.stringify({ botToken, signingSecret }),
      process.env.CREDENTIAL_KEY!,
    ),
    status: "configured",
    capabilities: ["exception_digest", "signed_approval", "signed_pause"],
    configuredBy: scope.userId,
  });
  await audit(tx, scope, "slack.channel_mandate", c.id, {
    teamId: input.teamId,
    channelId: input.channelId,
    allowApprovals: input.allowApprovals,
    validUntil: input.validUntil,
  });
  return publicEntity(c);
}

/** Durable, deduplicated intent. Only an explicit worker handoff may send it. */
export async function queueSlackDigest(tx: DbTx, scope: Scope) {
  owner(scope);
  const connector = await selectedConnector(tx, scope),
    c = data(connector);
  const open = (await list(tx, scope, "exceptions"))
    .filter((x) => data(x).status === "open")
    .slice(0, 12);
  const approvals: {
    contentId: string;
    version: number;
    packageHash: string;
    body: string;
    title: string;
    targetUrl: string | null;
    scheduledAt: string | null;
  }[] = [];
  if (c.allowApprovals)
    for (const item of await list(tx, scope, "content")) {
      const d = data(item);
      if (approvals.length >= 3) break;
      // Full text must fit the message; media/long-form packages remain web-reviewed.
      if (
        d.status !== "reviewed" ||
        d.type !== "social" ||
        d.risk !== "routine" ||
        d.assetId ||
        typeof d.body !== "string" ||
        d.body.length > 280
      )
        continue;
      const p = await preflight(tx, scope, item.id, {
        test: process.env.EXECUTION_MODE !== "live",
        ignoreApproval: true,
      });
      if (!p.allowed || p.policyInput?.mode !== "assisted") continue;
      const approved = (await list(tx, scope, "approvals")).some(
        (a) =>
          data(a).packageHash === p.packageHash &&
          data(a).status === "approved" &&
          new Date(data(a).expiresAt) > new Date(),
      );
      if (!approved)
        approvals.push({
          contentId: item.id,
          version: item.version,
          packageHash: p.packageHash,
          body: d.body,
          title: d.title,
          targetUrl: d.targetUrl ?? null,
          scheduledAt: d.scheduledAt ?? null,
        });
    }
  if (!open.length && !approvals.length)
    return { unchanged: true, reason: "NO_ACTIONABLE_ITEMS" };
  const snapshot = hash({
    connectorId: connector.id,
    connectorVersion: connector.version,
    exceptions: open.map((x) => [x.id, x.version]),
    approvals: approvals.map((x) => x.packageHash),
  });
  const existing = (await list(tx, scope, "slack_messages")).find(
    (x) => data(x).snapshot === snapshot,
  );
  if (existing) return { unchanged: true, message: existing };
  const messageId = randomUUID();
  const blocks: Record<string, unknown>[] = [];
  const lines = [
    `EDS Orbit: ${open.length} exception(s), ${approvals.length} approval(s) require review.`,
  ];
  for (const item of open) {
    const code = /^[A-Z0-9_]{1,80}$/.test(data(item).code)
      ? data(item).code
      : "OPERATION_NEEDS_REVIEW";
    lines.push(`${code} · ${item.id}`);
  }
  blocks.push({
    type: "section",
    text: { type: "plain_text", text: lines.join("\n") },
  });
  for (const a of approvals) {
    const action = await create(tx, scope, "slack_actions", {
      type: "approve",
      messageRef: messageId,
      connectorId: connector.id,
      connectorVersion: connector.version,
      contentId: a.contentId,
      contentVersion: a.version,
      packageHash: a.packageHash,
      expiresAt: new Date(
        Math.min(Date.parse(c.validUntil), Date.now() + 86400_000),
      ).toISOString(),
      status: "pending",
    });
    const text = `${a.title}\n${a.body}\nTarget: ${a.targetUrl ?? "(none)"}\nSchedule: ${a.scheduledAt ?? "immediate after separate publish intent"}\nPackage: ${a.packageHash}`;
    lines.push(text);
    blocks.push(
      { type: "section", text: { type: "plain_text", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "orbit_approve",
            value: action.id,
            text: { type: "plain_text", text: "Approve exact text" },
            confirm: {
              title: { type: "plain_text", text: "Approve this package?" },
              text: {
                type: "plain_text",
                text: "Approval is bound to this exact text, target, schedule and current evidence. It does not itself publish.",
              },
              confirm: { type: "plain_text", text: "Approve" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    );
  }
  const pause = await create(tx, scope, "slack_actions", {
    type: "pause",
    messageRef: messageId,
    connectorId: connector.id,
    connectorVersion: connector.version,
    expiresAt: new Date(
      Math.min(Date.parse(c.validUntil), Date.now() + 86400_000),
    ).toISOString(),
    status: "pending",
  });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: "orbit_pause",
        value: pause.id,
        text: { type: "plain_text", text: "Pause project" },
      },
    ],
  });
  const message = await create(tx, scope, "slack_messages", {
    messageRef: messageId,
    connectorId: connector.id,
    connectorVersion: connector.version,
    snapshot,
    status: "queued",
    channel: c.channelId,
    text: lines.join("\n\n"),
    blocks,
  });
  const job = await enqueue(
    tx,
    scope,
    "slack_notification",
    message.id,
    "slack:" + snapshot,
  );
  await audit(tx, scope, "slack.digest_queued", message.id, {
    exceptionCount: open.length,
    approvalCount: approvals.length,
  });
  return { message, job };
}

/** No live send occurs unless the global write gate and exact owner channel mandate both pass. */
export async function dispatchSlackDigest(
  scope: Scope,
  messageId: string,
  options: { fetch?: FetchLike } = {},
) {
  const prepared = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const message = await entity(tx, scope, "slack_messages", messageId),
        m = data(message);
      if (
        [
          "sent",
          "outcome_unknown",
          "sending",
          "failed",
          "blocked_dependency",
        ].includes(m.status)
      )
        return null;
      if (
        process.env.ENABLE_EXTERNAL_WRITES !== "true" ||
        process.env.EXECUTION_MODE !== "live"
      )
        throw new DomainError("SLACK_EXTERNAL_WRITES_DISABLED");
      const project = await tx.project.findUniqueOrThrow({
        where: { id: scope.projectId },
      });
      if (project.paused) throw new DomainError("PROJECT_PAUSED");
      const connector = await entity(tx, scope, "connectors", m.connectorId),
        c = data(connector);
      mandate(c);
      if (connector.version !== m.connectorVersion || c.channelId !== m.channel)
        throw new DomainError("SLACK_MANDATE_CHANGED");
      for (const item of await list(tx, scope, "slack_actions")) {
        const a = data(item);
        if (a.messageRef !== m.messageRef || a.type !== "approve") continue;
        if (a.status !== "pending" || !(new Date(a.expiresAt) > new Date()))
          throw new DomainError("SLACK_APPROVAL_STALE");
        const check = await preflight(tx, scope, a.contentId, {
          test: process.env.EXECUTION_MODE !== "live",
          ignoreApproval: true,
        });
        if (
          !check.allowed ||
          check.packageHash !== a.packageHash ||
          check.content.version !== a.contentVersion
        )
          throw new DomainError("SLACK_APPROVAL_STALE");
      }
      const fence = randomUUID();
      await update(tx, scope, message, {
        ...m,
        status: "sending",
        fence,
        handoffAt: new Date().toISOString(),
      });
      return { message: m, connector, credentials: credentials(c), fence };
    },
  );
  if (!prepared) return { unchanged: true };
  let result: {
    status: "sent" | "failed" | "outcome_unknown";
    remoteTs?: string;
  };
  try {
    const receipt = await createSlackClient({
      token: prepared.credentials.botToken,
      fetch: options.fetch,
    }).postMessage({
      channel: prepared.message.channel,
      text: prepared.message.text,
      blocks: prepared.message.blocks,
    });
    result = { status: "sent", remoteTs: receipt.ts };
  } catch (error) {
    result = {
      status:
        error instanceof ConnectorError && error.outcome !== "unknown"
          ? "failed"
          : "outcome_unknown",
    };
  }
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const message = await entity(tx, scope, "slack_messages", messageId);
    if (data(message).fence !== prepared.fence)
      throw new DomainError("STALE_FENCE");
    const done = await update(tx, scope, message, {
      ...data(message),
      ...result,
      completedAt: new Date().toISOString(),
    });
    if (result.status === "outcome_unknown")
      await exception(tx, scope, "SLACK_OUTCOME_UNKNOWN", messageId);
    await audit(tx, scope, "slack." + result.status, messageId, {
      remoteTs: result.remoteTs ?? null,
    });
    return done;
  });
}

export type SlackInbound = {
  workspaceId: string;
  projectId: string;
  rawBody: string | Buffer;
  timestamp: string;
  signature: string;
};
/** Router supplies the untouched form body. Signature, mapping, replay and mutation share this transaction. */
export async function handleSlackInteraction(input: SlackInbound) {
  z.uuid().parse(input.workspaceId);
  z.uuid().parse(input.projectId);
  const scope: Scope = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    userId: "slack-pending-verification",
    role: "owner",
  };
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    const connector = await selectedConnector(tx, scope),
      c = data(connector),
      secret = credentials(c);
    let mappedUser: string | undefined;
    const interaction = await verifySlackInteraction(
      {
        rawBody: input.rawBody,
        timestamp: input.timestamp,
        signature: input.signature,
        signingSecret: secret.signingSecret,
      },
      {
        expectedTeamId: c.teamId,
        expectedChannelId: c.channelId,
        authorize: async (interaction) => {
          const mapping = c.actors.find(
            (a: { slackUserId: string; orbitUserId: string }) =>
              a.slackUserId === interaction.slackUserId,
          );
          if (!mapping || !(await isOwner(scope, mapping.orbitUserId)))
            return false;
          mappedUser = mapping.orbitUserId;
          return true;
        },
        claimReplay: async (fingerprint, expiresAt) => {
          const previous = await tx.entity.findFirst({
            where: {
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              kind: "slack_inbox",
              data: { path: ["fingerprint"], equals: fingerprint },
            },
          });
          if (previous) return false;
          await create(tx, { ...scope, userId: mappedUser! }, "slack_inbox", {
            fingerprint,
            connectorId: connector.id,
            expiresAt: expiresAt.toISOString(),
          });
          return true;
        },
      },
    );
    const actorScope = { ...scope, userId: mappedUser! };
    const action = await entity(
        tx,
        actorScope,
        "slack_actions",
        z.uuid().parse(interaction.value),
      ),
      a = data(action);
    if (
      a.connectorId !== connector.id ||
      a.connectorVersion !== connector.version ||
      a.status !== "pending" ||
      !(new Date(a.expiresAt) > new Date()) ||
      interaction.actionId !== "orbit_" + a.type
    )
      throw new DomainError("SLACK_ACTION_STALE", 409);
    const message = await tx.entity.findFirst({
      where: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        kind: "slack_messages",
        data: { path: ["messageRef"], equals: a.messageRef },
      },
    });
    if (!message || !["sent", "outcome_unknown"].includes(data(message).status))
      throw new DomainError("SLACK_MESSAGE_NOT_SENT", 409);
    if (a.type === "approve") {
      if (!c.allowApprovals)
        throw new DomainError("SLACK_APPROVAL_NOT_ALLOWED");
      const p = await preflight(tx, actorScope, a.contentId, {
        test: process.env.EXECUTION_MODE !== "live",
        ignoreApproval: true,
      });
      if (
        !p.allowed ||
        p.packageHash !== a.packageHash ||
        p.content.version !== a.contentVersion
      )
        throw new DomainError("SLACK_APPROVAL_STALE", 409);
      await approve(tx, actorScope, {
        contentId: a.contentId,
        version: a.contentVersion,
        packageHash: a.packageHash,
      });
    } else if (a.type === "pause") {
      await tx.project.update({
        where: { id: scope.projectId },
        data: { paused: true, generation: { increment: 1 } },
      });
      for (const pub of await list(tx, actorScope, "publications")) {
        const p = data(pub);
        if (p.status === "intent_created")
          await update(tx, actorScope, pub, {
            ...p,
            status: "blocked_dependency",
            reason: "PROJECT_PAUSED",
          });
        if (
          [
            "scheduled_remote",
            "sending",
            "outcome_unknown",
            "reconciliation_required",
          ].includes(p.status)
        ) {
          await update(tx, actorScope, pub, {
            ...p,
            status: "reconciliation_required",
            reason: "PROJECT_PAUSED",
          });
          await exception(
            tx,
            actorScope,
            "REMOTE_ACTION_RECONCILIATION_REQUIRED",
            pub.id,
          );
          await enqueue(
            tx,
            actorScope,
            "reconciliation",
            pub.id,
            "slack-pause-reconcile:" + action.id + ":" + pub.id,
          );
        }
      }
    } else throw new DomainError("SLACK_ACTION_NOT_ALLOWED");
    await update(tx, actorScope, action, {
      ...a,
      status: "consumed",
      consumedBy: mappedUser,
      consumedAt: new Date().toISOString(),
    });
    await audit(tx, actorScope, "slack.action_" + a.type, action.id, {
      fingerprint: interaction.fingerprint,
    });
    return {
      accepted: true,
      action: a.type,
      message:
        a.type === "approve"
          ? "Exact package approved. No publication was sent by this action."
          : "Project paused. Existing remote work requires reconciliation.",
    };
  });
}

/** Worker crash recovery: an interrupted send is never blindly repeated. */
export async function markSlackOutcomeUnknown(
  tx: DbTx,
  scope: Scope,
  messageId: string,
) {
  const message = await entity(tx, scope, "slack_messages", messageId);
  if (data(message).status !== "sending") return message;
  const changed = await update(tx, scope, message, {
    ...data(message),
    status: "outcome_unknown",
    recoveredAt: new Date().toISOString(),
  });
  await exception(tx, scope, "SLACK_OUTCOME_UNKNOWN", messageId);
  return changed;
}
