import { calendarConflicts } from "./calendar.ts";
import { isAssignedPostizChannel } from "./postiz-assignment.ts";
import { invalidateContent } from "./content-invalidation.ts";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import { profileGuardrailProblems } from "./marketing-profile.ts";
import { channelLimitExceeded, resolveChannelRules } from "./channel-rules.ts";
import { factClaimMatches } from "./fact-claims.ts";
import {
  policy as policySchema,
  type Scope,
} from "../../../../packages/schemas/src/index.ts";
import {
  validateEvidence,
  validateActiveIndexEvaluation,
} from "../../../../packages/knowledge/src/index.ts";
import {
  data,
  entity,
  list,
  hash,
  DomainError,
  create,
  update,
  audit,
} from "../shared.ts";
export async function activePolicy(tx: DbTx, scope: Scope) {
  const rows = await list(tx, scope, "policies");
  const row = rows.find((x) => data(x).active === true);
  return row ?? null;
}
export async function packageFor(tx: DbTx, scope: Scope, contentId: string) {
  const content = await entity(tx, scope, "content", contentId);
  const policy = await activePolicy(tx, scope);
  const asset = data(content).assetId
    ? await entity(tx, scope, "assets", data(content).assetId)
    : null;
  const evidence = await entity(
    tx,
    scope,
    "evidence",
    data(content).evidenceId,
  );
  const connector = (await list(tx, scope, "connectors")).find(
    (x) => data(x).provider === "postiz" && data(x).status === "write_verified",
  );
  const packageData = {
    projectId: scope.projectId,
    connectorId: connector?.id ?? null,
    connectorVersion: connector?.version ?? null,
    connectorBaseUrl: connector ? data(connector).baseUrl : null,
    contentId,
    contentVersion: content.version,
    body: data(content).body,
    title: data(content).title,
    channel: data(content).channel,
    targetUrl: data(content).targetUrl ?? null,
    assetId: asset?.id ?? null,
    assetVersion: asset?.version ?? null,
    assetHash: asset ? hash(data(asset)) : null,
    scheduledAt: data(content).scheduledAt ?? null,
    evidenceId: evidence.id,
    evidenceVersion: evidence.version,
    evidenceHash: hash(data(evidence)),
    policyId: policy?.id ?? null,
    policyVersion: policy?.version ?? null,
  };
  return {
    content,
    policy,
    evidence,
    packageData,
    packageHash: hash(packageData),
  };
}
export async function checkClaims(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  at = new Date(),
) {
  const content = await entity(tx, scope, "content", contentId),
    v = data(content),
    problems: string[] = [];
  const evidence = await entity(tx, scope, "evidence", v.evidenceId);
  const validation = await validateEvidence(tx, scope, evidence.id, at);
  if ((validation as any).valid === false || (validation as any).ok === false)
    problems.push("EVIDENCE_INVALID");
  const e = data(evidence);
  if (e.status === "insufficient_evidence" || e.purpose !== "public")
    problems.push("INSUFFICIENT_PUBLIC_EVIDENCE");
  if (!v.claims?.length) problems.push("CLAIM_LEDGER_REQUIRED");
  for (const claim of v.claims ?? []) {
    if (claim.kind === "style") {
      if (!v.body.includes(claim.text)) problems.push("CLAIM_NOT_IN_CONTENT");
      if (
        !["Learn more.", "Mehr erfahren."].includes(claim.text) &&
        v.humanReviewedBodyHash !== hash(v.body)
      )
        problems.push("HUMAN_CONTENT_REVIEW_REQUIRED");
      continue;
    }
    if (!v.body.includes(claim.text)) problems.push("CLAIM_NOT_IN_CONTENT");
    if (claim.factId) {
      const fact = await entity(tx, scope, "facts", claim.factId);
      const f = data(fact);
      if (
        f.status !== "verified" ||
        f.publicUse !== true ||
        Date.parse(f.validFrom) > at.valueOf() ||
        (f.validUntil && Date.parse(f.validUntil) <= at.valueOf())
      )
        problems.push("FACT_NOT_VERIFIED");
      if (!factClaimMatches(claim.text, f))
        problems.push("FACT_VALUE_MISMATCH");
      if (
        !(e.facts ?? []).some(
          (item: any) => item.id === fact.id && item.version === fact.version,
        )
      )
        problems.push("FACT_OUTSIDE_EVIDENCE");
    } else if (claim.chunkId) {
      const chunk = await tx.knowledgeChunk.findFirst({
        where: { id: claim.chunkId, projectId: scope.projectId },
      });
      if (
        !chunk ||
        !chunk.text.includes(claim.text) ||
        !JSON.stringify(e).includes(claim.chunkId)
      )
        problems.push("QUOTE_NOT_SUPPORTED");
    } else problems.push("UNSUPPORTED_CLAIM");
  }
  // Arbitrary free text needs an explicit owner review; models cannot certify their own extra claims.
  const normalized = (s: string) => s.replace(/[\s\p{P}]/gu, "").toLowerCase();
  let remainder = v.body;
  for (const claim of [...(v.claims ?? [])].sort(
    (a: any, b: any) => b.text.length - a.text.length,
  )) {
    const position = remainder.indexOf(claim.text);
    if (position >= 0)
      remainder =
        remainder.slice(0, position) +
        remainder.slice(position + claim.text.length);
  }
  const covered = normalized(remainder) === "";
  if (!covered && v.humanReviewedBodyHash !== hash(v.body))
    problems.push("HUMAN_CONTENT_REVIEW_REQUIRED");
  if (
    v.type === "social" &&
    channelLimitExceeded(
      v.body,
      v.targetUrl,
      await resolveChannelRules(tx, scope, v.channel, v.type, !!v.assetId),
    )
  )
    problems.push("CHANNEL_LIMIT_EXCEEDED");
  problems.push(...(await profileGuardrailProblems(tx, scope, v, at)));
  return { valid: problems.length === 0, problems: [...new Set(problems)] };
}
export async function preflight(
  tx: DbTx,
  scope: Scope,
  contentId: string,
  options: { test: boolean; at?: Date; ignoreApproval?: boolean } = {
    test: true,
  },
) {
  const at = options.at ?? new Date(),
    pkg = await packageFor(tx, scope, contentId),
    c = data(pkg.content);
  const blockers: string[] = [];
  const project = await tx.project.findUniqueOrThrow({
    where: { id: scope.projectId },
  });
  if (project.paused) blockers.push("PROJECT_PAUSED");
  if (!c.synthetic && (!c.missionId || !c.campaignType || !c.profileVersion))
    blockers.push("CAMPAIGN_MISSION_REQUIRED");
  if (c.missionId) {
    const mission = await entity(tx, scope, "missions", c.missionId),
      m = data(mission);
    if (at < new Date(m.startAt) || at >= new Date(m.endAt))
      blockers.push("MISSION_EXPIRED");
    if (!m.channels.includes(c.channel) || m.contentType !== c.type)
      blockers.push("MISSION_SCOPE_NOT_ALLOWED");
    if (
      options.test &&
      m.allowedActions &&
      !m.allowedActions.includes("publish_test")
    )
      blockers.push("MISSION_TEST_WRITE_NOT_AUTHORIZED");
  }
  if (c.type === "social")
    for (const previous of await list(tx, scope, "content")) {
      const d = data(previous);
      if (
        previous.id === contentId ||
        d.channel !== c.channel ||
        previous.createdAt >= pkg.content.createdAt ||
        !["reviewed", "draft"].includes(d.status)
      )
        continue;
      const normalized = (v: string) =>
        v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      const exact = normalized(d.body ?? "") === normalized(c.body ?? "");
      const ownClaims = (c.claims ?? [])
          .filter((v: any) => v.kind !== "style")
          .map((v: any) => v.factId ?? v.chunkId),
        priorClaims = new Set(
          (d.claims ?? []).map((v: any) => v.factId ?? v.chunkId),
        );
      const overlap =
        ownClaims.length > 0 &&
        ownClaims.every((id: string) => priorClaims.has(id));
      if (
        (exact || overlap) &&
        (await validateEvidence(tx, scope, d.evidenceId, at)).valid
      ) {
        blockers.push(exact ? "DUPLICATE_CONTENT" : "CLAIM_OVERLAP_DUPLICATE");
        break;
      }
    }

  if ((await calendarConflicts(tx, scope, c.channel, at)).length)
    blockers.push("MANUAL_CALENDAR_BLOCK");
  if (!pkg.policy) blockers.push("POLICY_REQUIRED");
  const p = pkg.policy
    ? policySchema.parse(
        Object.fromEntries(
          Object.entries(data(pkg.policy)).filter(
            ([k]) => !["active", "activatedAt", "activatedBy"].includes(k),
          ),
        ),
      )
    : null;
  if (p) {
    if (at < new Date(p.startAt) || at >= new Date(p.endAt))
      blockers.push("POLICY_EXPIRED");
    if (!p.channels.includes(c.channel) || !p.contentTypes.includes(c.type))
      blockers.push("SCOPE_NOT_ALLOWED");
    if (c.targetUrl && !p.allowedOrigins.includes(new URL(c.targetUrl).origin))
      blockers.push("LINK_NOT_ALLOWED");
    if (c.risk !== "routine" || ["ad"].includes(c.type))
      blockers.push("SENSITIVE_REQUIRES_SEPARATE_APPROVAL");
    if (!options.test && p.mode === "observe")
      blockers.push("OBSERVE_FORBIDS_EXTERNAL_WRITE");
    if (!options.test && c.synthetic)
      blockers.push("SYNTHETIC_CONTENT_NO_LIVE_WRITE");
    const hour = Number(
      new Intl.DateTimeFormat("en", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: project.timezone,
      }).format(at),
    );
    if (
      p.quietStart !== undefined &&
      p.quietEnd !== undefined &&
      (p.quietStart <= p.quietEnd
        ? hour >= p.quietStart && hour < p.quietEnd
        : hour >= p.quietStart || hour < p.quietEnd)
    )
      blockers.push("QUIET_HOURS");
    if (p.mode === "assisted" && !options.ignoreApproval) {
      const approval = (await list(tx, scope, "approvals")).find(
        (x) =>
          data(x).packageHash === pkg.packageHash &&
          data(x).status === "approved" &&
          new Date(data(x).expiresAt) > at,
      );
      if (!approval) blockers.push("APPROVAL_REQUIRED");
    }
  }
  const claims = await checkClaims(tx, scope, contentId, at);
  blockers.push(...claims.problems);
  if (c.assetId) {
    const asset = await entity(tx, scope, "assets", c.assetId);
    if (
      !data(asset).usageApproved ||
      data(asset).assetStatus !== "approved" ||
      data(asset).mime !== "image/png" ||
      !data(asset).base64
    )
      blockers.push("ASSET_NOT_APPROVED_OR_UNSUPPORTED");
  }
  if (c.status !== "reviewed") blockers.push("REVIEW_REQUIRED");
  if (!options.test) {
    if (c.type !== "social")
      blockers.push("LIVE_CONTENT_PROVIDER_CAPABILITY_NOT_CONFIGURED");
    else if (
      !(await resolveChannelRules(tx, scope, c.channel, c.type, !!c.assetId))
        .liveCapabilityKnown
    )
      blockers.push("CHANNEL_CAPABILITY_UNVERIFIED");
    if (process.env.ENABLE_EXTERNAL_WRITES !== "true")
      blockers.push("EXTERNAL_WRITES_DISABLED");
    const liveEvaluation = await validateActiveIndexEvaluation(tx, scope, at);
    if (!liveEvaluation.valid) blockers.push("LIVE_RAG_EVAL_REQUIRED");
    const connector = (await list(tx, scope, "connectors")).find(
      (x) =>
        data(x).provider === "postiz" && data(x).status === "write_verified",
    );
    if (c.missionId) {
      const mission = await entity(tx, scope, "missions", c.missionId);
      if (!(data(mission).allowedActions ?? []).includes("publish_live"))
        blockers.push("MISSION_LIVE_WRITE_NOT_AUTHORIZED");
    }
    if (!connector) blockers.push("PUBLISHER_WRITE_VERIFICATION_REQUIRED");
    else if (
      !isAssignedPostizChannel(data(connector), c.channel) ||
      !(data(connector).writeVerifiedIntegrationIds ?? []).includes(
        c.channel,
      ) ||
      data(connector).writeVerifiedInstanceId !==
        process.env.PUBLISHER_INSTANCE_ID
    )
      blockers.push("CHANNEL_WRITE_VERIFICATION_REQUIRED");
  }
  if (!options.test && c.assetId) {
    const connector = (await list(tx, scope, "connectors")).find(
      (x) =>
        data(x).provider === "postiz" && data(x).status === "write_verified",
    );
    if (
      !(data(connector).writeVerifiedMediaIntegrationIds ?? []).includes(
        c.channel,
      )
    )
      blockers.push("CHANNEL_MEDIA_VERIFICATION_REQUIRED");
  }
  return {
    ...pkg,
    policyInput: p,
    allowed: blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
}
export async function approve(
  tx: DbTx,
  scope: Scope,
  input: { contentId: string; version: number; packageHash: string },
) {
  if (scope.role !== "owner") throw new DomainError("OWNER_REQUIRED", 403);
  const p = await packageFor(tx, scope, input.contentId);
  if (
    p.content.version !== input.version ||
    p.packageHash !== input.packageHash
  )
    throw new DomainError("STALE_APPROVAL", 409);
  const existing = (await list(tx, scope, "approvals")).find(
    (x) =>
      data(x).packageHash === p.packageHash &&
      data(x).status === "approved" &&
      new Date(data(x).expiresAt) > new Date(),
  );
  if (existing) return existing;
  await audit(tx, scope, "approve", p.content.id, {
    packageHash: p.packageHash,
  });
  return create(tx, scope, "approvals", {
    contentId: p.content.id,
    packageHash: p.packageHash,
    status: "approved",
    userId: scope.userId,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}
