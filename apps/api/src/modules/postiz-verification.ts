import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authDb,
  scoped,
  type DbTx,
} from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import {
  createPostizClient,
  ConnectorError,
  type FetchLike,
} from "../../../../packages/connectors/src/index.ts";
import {
  audit,
  create,
  data,
  decrypt,
  DomainError,
  entity,
  exception,
  hash,
  list,
  update,
} from "../shared.ts";

export const postizVerificationInput = z
  .object({
    connectorId: z.uuid(),
    integrationId: z.string().min(1).max(200),
    confirmSandboxAccount: z.literal(true),
    assetId: z.uuid().optional(),
  })
  .strict();
export const postizVerificationApproval = z
  .object({
    verificationId: z.uuid(),
    packageHash: z.string().regex(/^[a-f0-9]{64}$/),
    confirmPublishExactTest: z.literal(true),
  })
  .strict();
const run = <T>(s: Scope, work: (tx: DbTx) => Promise<T>) =>
  scoped(s.workspaceId, s.projectId, work);
async function owner(s: Scope) {
  if (
    s.role !== "owner" ||
    !(await authDb.project.findFirst({
      where: {
        id: s.projectId,
        workspaceId: s.workspaceId,
        OR: [
          {
            workspace: {
              members: { some: { userId: s.userId, role: "owner" } },
            },
          },
          { members: { some: { userId: s.userId, role: "owner" } } },
        ],
      },
      select: { id: true },
    }))
  )
    throw new DomainError("OWNER_REQUIRED", 403);
}
const writes = () => {
  if (
    process.env.EXECUTION_MODE !== "live" ||
    process.env.ENABLE_EXTERNAL_WRITES !== "true"
  )
    throw new DomainError("POSTIZ_EXTERNAL_WRITES_DISABLED", 409);
};
async function connector(
  tx: DbTx,
  s: Scope,
  verification: Record<string, any>,
) {
  const row = await entity(tx, s, "connectors", verification.connectorId),
    c = data(row);
  if (
    c.provider !== "postiz" ||
    row.version !== verification.connectorVersion ||
    c.baseUrl !== verification.baseUrl ||
    process.env.PUBLISHER_INSTANCE_ID !== verification.instanceId
  )
    throw new DomainError("POSTIZ_VERIFICATION_DEPENDENCY_CHANGED", 409);
  return { row, c };
}
async function approvedAsset(
  tx: DbTx,
  s: Scope,
  assetId: string,
  expected?: Record<string, any>,
) {
  const row = await entity(tx, s, "assets", assetId),
    a = data(row);
  if (
    a.mime !== "image/png" ||
    a.usageApproved !== true ||
    typeof a.base64 !== "string"
  )
    throw new DomainError("POSTIZ_TEST_ASSET_NOT_APPROVED", 409);
  const bytes = Buffer.from(a.base64, "base64");
  if (
    bytes.length < 24 ||
    bytes.length > 20 * 1024 * 1024 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new DomainError("POSTIZ_TEST_ASSET_INVALID", 409);
  const metadata = {
    assetId,
    version: row.version,
    hash: createHash("sha256").update(bytes).digest("hex"),
    mime: a.mime,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
  if (expected && hash(metadata) !== hash(expected))
    throw new DomainError("POSTIZ_TEST_ASSET_CHANGED", 409);
  return { metadata, bytes };
}
/** Preparation records a reviewable, fixed test package; it makes no provider request. */
export async function preparePostizVerification(
  tx: DbTx,
  s: Scope,
  raw: z.input<typeof postizVerificationInput>,
) {
  await owner(s);
  const input = postizVerificationInput.parse(raw),
    row = await entity(tx, s, "connectors", input.connectorId),
    c = data(row);
  if (
    c.provider !== "postiz" ||
    !["read_verified", "write_verified"].includes(c.status) ||
    !process.env.PUBLISHER_INSTANCE_ID
  )
    throw new DomainError("POSTIZ_READ_VERIFICATION_REQUIRED", 409);
  const account = (c.channels ?? []).find(
    (a: any) => a.id === input.integrationId && !a.disabled,
  );
  if (!account) throw new DomainError("POSTIZ_ACCOUNT_UNAVAILABLE", 409);
  const pending = (await list(tx, s, "connector_verifications")).find(
    (v) =>
      data(v).connectorId === row.id &&
      data(v).integrationId === account.id &&
      ["prepared", "sending", "accepted", "outcome_unknown"].includes(
        data(v).status,
      ) &&
      (data(v).status !== "prepared" ||
        Date.parse(data(v).expiresAt) > Date.now()),
  );
  if (pending) return pending;
  const reference = randomUUID(),
    date = new Date().toISOString();
  const asset = input.assetId
    ? (await approvedAsset(tx, s, input.assetId)).metadata
    : null;
  const packet = {
    connectorId: row.id,
    connectorVersion: row.version,
    baseUrl: c.baseUrl,
    instanceId: process.env.PUBLISHER_INSTANCE_ID,
    integrationId: account.id,
    integrationName: account.name,
    integrationIdentifier: account.identifier,
    reference,
    date,
    body: `EDS Orbit connection verification. Test reference: ${reference}.`,
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    type: "now",
    asset,
  };
  const result = await create(tx, s, "connector_verifications", {
    ...packet,
    packageHash: hash(packet),
    status: "prepared",
    createdBy: s.userId,
    sandboxAccountAcknowledged: true,
    cleanup:
      "Review and remove the test post in the provider after verification. Automatic group deletion is not authorized.",
  });
  await audit(tx, s, "postiz.verification_prepared", result.id, {
    packageHash: data(result).packageHash,
    integrationId: account.id,
  });
  return result;
}
/** A single explicit owner approval authorizes exactly the prepared test post, never a campaign. */
export async function executePostizVerification(
  s: Scope,
  raw: z.input<typeof postizVerificationApproval>,
  options: { fetch?: FetchLike } = {},
) {
  await owner(s);
  writes();
  const input = postizVerificationApproval.parse(raw);
  const prepared = await run(s, async (tx) => {
    const v = await entity(
        tx,
        s,
        "connector_verifications",
        input.verificationId,
      ),
      d = data(v);
    if (d.packageHash !== input.packageHash)
      throw new DomainError("POSTIZ_TEST_PACKAGE_CHANGED", 409);
    if (d.status !== "prepared") return { done: v };
    if (Date.parse(d.expiresAt) <= Date.now())
      throw new DomainError("POSTIZ_TEST_APPROVAL_EXPIRED", 409);
    if (
      (await tx.project.findUniqueOrThrow({ where: { id: s.projectId } }))
        .paused
    )
      throw new DomainError("PROJECT_PAUSED", 409);
    const { c } = await connector(tx, s, d);
    const token = decrypt(c.encryptedCredential, process.env.CREDENTIAL_KEY!);
    const assetBytes = d.asset
      ? (await approvedAsset(tx, s, d.asset.assetId, d.asset)).bytes
      : null;
    const fence = randomUUID();
    await update(tx, s, v, {
      ...d,
      status: "sending",
      fence,
      approvedBy: s.userId,
      approvedAt: new Date().toISOString(),
    });
    await audit(tx, s, "postiz.verification_handoff", v.id, {
      packageHash: d.packageHash,
      fence,
    });
    return { packet: d, fence, token, assetBytes };
  });
  if ("done" in prepared) return prepared.done;
  const p = prepared.packet;
  let remoteId: string;
  try {
    const client = createPostizClient({
      baseUrl: p.baseUrl,
      token: prepared.token,
      fetch: options.fetch,
    });
    const images: { id: string; path: string }[] = [];
    if (prepared.assetBytes) {
      const media = await client.uploadMedia({
        bytes: prepared.assetBytes,
        mime: "image/png",
        filename: "orbit-connection-test.png",
      });
      images.push(media);
      await run(s, async (tx) => {
        const row = await entity(
          tx,
          s,
          "connector_verifications",
          input.verificationId,
        );
        if (data(row).fence !== prepared.fence)
          throw new DomainError("STALE_FENCE", 409);
        await update(tx, s, row, { ...data(row), uploadedMedia: media });
      });
    }
    await owner(s);
    writes();
    await run(s, async (tx) => {
      const row = await entity(
          tx,
          s,
          "connector_verifications",
          input.verificationId,
        ),
        d = data(row);
      if (
        d.status !== "sending" ||
        d.fence !== prepared.fence ||
        d.packageHash !== input.packageHash ||
        Date.parse(d.expiresAt) <= Date.now()
      )
        throw new DomainError("POSTIZ_TEST_PACKAGE_CHANGED", 409);
      if (
        (await tx.project.findUniqueOrThrow({ where: { id: s.projectId } }))
          .paused
      )
        throw new DomainError("PROJECT_PAUSED", 409);
      await connector(tx, s, d);
      if (d.asset) await approvedAsset(tx, s, d.asset.assetId, d.asset);
    });
    const result = await client.createPost({
      type: "now",
      date: p.date,
      shortLink: false,
      tags: [],
      posts: [
        {
          integration: { id: p.integrationId },
          value: [{ content: p.body, image: images }],
          settings: { __type: p.integrationIdentifier },
        },
      ],
    });
    remoteId = result.remotePosts[0]!.postId;
  } catch (error) {
    const outcome =
      error instanceof ConnectorError && error.outcome !== "unknown"
        ? "rejected"
        : "outcome_unknown";
    return run(s, async (tx) => {
      const v = await entity(
        tx,
        s,
        "connector_verifications",
        input.verificationId,
      );
      if (data(v).fence !== prepared.fence)
        throw new DomainError("STALE_FENCE", 409);
      const result = await update(tx, s, v, {
        ...data(v),
        status: outcome,
        errorCode:
          error instanceof ConnectorError
            ? error.code
            : "PROVIDER_OUTCOME_UNKNOWN",
      });
      if (outcome === "outcome_unknown")
        await exception(tx, s, "POSTIZ_VERIFICATION_OUTCOME_UNKNOWN", v.id);
      return result;
    });
  }
  return run(s, async (tx) => {
    const v = await entity(
      tx,
      s,
      "connector_verifications",
      input.verificationId,
    );
    if (data(v).fence !== prepared.fence)
      throw new DomainError("STALE_FENCE", 409);
    return update(tx, s, v, {
      ...data(v),
      remoteId,
      status: "accepted",
      receivedAt: new Date().toISOString(),
    });
  });
}
/** Status observation is read-only at Postiz. An accepted HTTP receipt never enables publishing. */
export async function reconcilePostizVerification(
  s: Scope,
  verificationId: string,
  options: { fetch?: FetchLike } = {},
) {
  await owner(s);
  z.uuid().parse(verificationId);
  const prepared = await run(s, async (tx) => {
    const v = await entity(tx, s, "connector_verifications", verificationId),
      d = data(v);
    if (d.status === "verified") return { done: v };
    if (!d.remoteId) {
      if (
        d.status === "sending" &&
        Date.now() - Date.parse(d.approvedAt) > 60000
      ) {
        const updated = await update(tx, s, v, {
          ...d,
          status: "outcome_unknown",
          errorCode: "INTERRUPTED_HANDOFF",
        });
        await exception(tx, s, "POSTIZ_VERIFICATION_OUTCOME_UNKNOWN", v.id);
        return { done: updated };
      }
      return { done: v };
    }
    const { c } = await connector(tx, s, d);
    return {
      packet: d,
      token: decrypt(c.encryptedCredential, process.env.CREDENTIAL_KEY!),
    };
  });
  if ("done" in prepared) return prepared.done;
  const p = prepared.packet,
    anchor = Date.parse(p.date);
  const observed = await createPostizClient({
    baseUrl: p.baseUrl,
    token: prepared.token,
    fetch: options.fetch,
  }).findPostStatus(p.remoteId, {
    startDate: new Date(anchor - 86400000).toISOString(),
    endDate: new Date(anchor + 86400000).toISOString(),
  });
  return run(s, async (tx) => {
    const v = await entity(tx, s, "connector_verifications", verificationId),
      d = data(v),
      { row, c } = await connector(tx, s, d);
    if (
      !observed.found ||
      observed.post.integration.id !== d.integrationId ||
      observed.post.state !== "PUBLISHED"
    )
      return update(tx, s, v, {
        ...d,
        remoteState: observed.found ? observed.post.state : "UNKNOWN",
        observedAt: new Date().toISOString(),
      });
    const checkedAt = new Date().toISOString();
    const verified = await update(tx, s, row, {
      ...c,
      status: "write_verified",
      writeVerifiedInstanceId: d.instanceId,
      writeVerifiedMediaIntegrationIds: d.asset
        ? [
            ...new Set([
              ...(c.writeVerifiedMediaIntegrationIds ?? []),
              d.integrationId,
            ]),
          ]
        : (c.writeVerifiedMediaIntegrationIds ?? []),
      writeVerifiedIntegrationIds: [
        ...new Set([...(c.writeVerifiedIntegrationIds ?? []), d.integrationId]),
      ],
      writeVerification: {
        verificationId: v.id,
        remoteId: d.remoteId,
        observedState: "PUBLISHED",
        checkedAt,
        instanceId: d.instanceId,
        baseUrl: d.baseUrl,
        connectorVersion: row.version + 1,
        integrationId: d.integrationId,
        packageHash: d.packageHash,
        capability: d.asset ? "png_publish_now" : "text_publish_now",
      },
    });
    const result = await update(tx, s, v, {
      ...d,
      status: "verified",
      verifiedConnectorVersion: verified.version,
      remoteState: "PUBLISHED",
      observedAt: checkedAt,
    });
    await audit(tx, s, "postiz.write_verified", row.id, {
      verificationId: v.id,
      integrationId: d.integrationId,
      remoteId: d.remoteId,
      capability: d.asset ? "png_publish_now" : "text_publish_now",
    });
    return result;
  });
}
