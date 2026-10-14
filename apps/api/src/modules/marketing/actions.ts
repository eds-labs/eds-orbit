import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import * as schemas from "../../../../../packages/schemas/src/index.ts";
import {
  ConnectorError,
  createMatomoClient,
  createPostizClient,
  importAdsCsv,
} from "../../../../../packages/connectors/src/index.ts";
import {
  ownTransaction,
  sharedTransaction,
  type ActionHandler,
} from "../../platform/http/actions.ts";
import { enqueue } from "../../platform/jobs/enqueue.ts";
import {
  audit,
  create,
  data,
  decrypt,
  DomainError,
  entity,
  list,
  publicEntity,
  update,
} from "../../shared.ts";
import { renderProjectAsset } from "./brand/render-asset.ts";
import { importMatomoReport, matomoImportInput } from "./analytics/matomo.ts";
import { configureMatomoSchedule } from "./analytics/matomo-schedule.ts";
import {
  correctMetric,
  evaluateExperiment,
  memoryLifecycle,
  stopExperiment,
} from "./analytics/lifecycle.ts";
import {
  handoffPostizDraft,
  resolvePostizDraft,
} from "./publishing/postiz-draft.ts";
import {
  executePostizVerification,
  postizVerificationApproval,
  postizVerificationInput,
  preparePostizVerification,
  reconcilePostizVerification,
} from "./publishing/postiz-verification.ts";
import {
  assignPostizChannels,
  postizAssignmentInput,
  postizHealthStatus,
} from "./publishing/postiz-assignment.ts";
import {
  blockCalendar,
  calendarBlock,
  unblockCalendar,
} from "./publishing/calendar.ts";
import {
  configureSlack,
  queueSlackDigest,
  slackConfiguration,
} from "./publishing/slack.ts";
import {
  adaptContent,
  briefProposalInput,
  communityImportInput,
  communityLinkInput,
  contentAdaptationInput,
  importCommunityQuestions,
  linkCommunityGroup,
  proposeBrief,
} from "./pipeline/editorial.ts";
import {
  approveAndSchedule,
  configureAutopilot,
} from "./pipeline/autopilot.ts";
import { resumePausedPublications } from "./pipeline/paused-posts.ts";
import { archiveMission } from "./pipeline/mission-archive.ts";
import {
  archiveOldDrafts,
  restoreDraftCleanup,
} from "./pipeline/draft-cleanup.ts";
import {
  analyze,
  planMission,
  publishIntent,
  reviewContent,
  startApprovedLiveDraftOnce,
} from "./pipeline/workflow.ts";
import {
  MAX_BATCH_DRAFTS,
  resumeLiveDraftBatch,
  startApprovedLiveDraftBatch,
} from "./pipeline/draft-batch.ts";
import { approve, preflight } from "./policy/policy.ts";

/**
 * Marketing's project actions (WP2.1f), moved unchanged from the if-chain in
 * server.ts. The first group opens its own transactions (provider calls,
 * Drive reads that need the project lock); the rest runs in the shared one.
 */
export const marketingActions: Record<string, ActionHandler> = {
  render: ownTransaction(({ scope, input }) =>
    renderProjectAsset(scope, input),
  ),
  "import-matomo": ownTransaction(({ scope, input }) =>
    importMatomoReport(scope, matomoImportInput.parse(input)),
  ),
  "postiz-draft-handoff": ownTransaction(({ scope, input }) =>
    handoffPostizDraft(scope, input),
  ),
  // Preparation may read a Drive asset, which needs the project lock that a
  // shared transaction would already hold.
  "postiz-test-prepare": ownTransaction(({ scope, input }) =>
    preparePostizVerification(scope, postizVerificationInput.parse(input)),
  ),
  "postiz-test-execute": ownTransaction(({ scope, input }) =>
    executePostizVerification(scope, postizVerificationApproval.parse(input)),
  ),
  "postiz-test-reconcile": ownTransaction(({ scope, input }) =>
    reconcilePostizVerification(scope, schemas.id.parse(input.verificationId)),
  ),
  // Transitional: Postiz and Matomo checks behind a platform permission;
  // the connections registry (WP2.5) separates credentials from providers.
  "connector-health": ownTransaction(async ({ scope, input, config }) => {
    const c = await scoped(scope.workspaceId, scope.projectId, (tx) =>
        entity(tx, scope, "connectors", schemas.id.parse(input.connectorId)),
      ),
      d = data(c);
    let result: Record<string, unknown>;
    const options = {
      baseUrl: d.baseUrl,
      token: decrypt(d.encryptedCredential, config.CREDENTIAL_KEY),
    };
    if (d.provider === "postiz") {
      const client = createPostizClient(options);
      const channels = await client.listIntegrations();
      const checkedAt = new Date().toISOString();
      let groups: Awaited<ReturnType<typeof client.listGroups>> = [];
      try {
        groups = await client.listGroups();
      } catch (error) {
        if (!(error instanceof ConnectorError && error.status === 404))
          throw error;
      }
      const connection = {
        connected: true,
        provider: "postiz",
        baseUrl: client.baseUrl,
        channelCount: channels.length,
        checkedAt,
        error: null,
      };
      result = {
        status: postizHealthStatus(d),
        capabilities: client.capabilities,
        channels,
        groups,
        baseUrl: client.baseUrl,
        connection,
        lastSuccessfulConnection: checkedAt,
      };
    } else if (d.provider === "matomo") {
      const client = createMatomoClient({
        ...options,
        allowedSiteIds: [Number(d.siteId)],
      });
      await client.report({
        siteId: Number(d.siteId),
        method: "Goals.getGoals",
        period: "day",
        date: new Date().toISOString().slice(0, 10),
        siteTimezone: "UTC",
      });
      result = { status: "read_verified", capabilities: client.capabilities };
    } else throw new DomainError("SLACK_DELIVERY_TEST_REQUIRES_AUTHORIZATION");
    return scoped(scope.workspaceId, scope.projectId, async (tx) => {
      const current = await entity(tx, scope, "connectors", c.id);
      if (current.version !== c.version)
        throw new DomainError("CONNECTOR_CHANGED");
      return publicEntity(
        await update(tx, scope, current, {
          ...d,
          ...result,
          verifiedAt: new Date().toISOString(),
        }),
      );
    });
  }),

  "postiz-assign-channels": sharedTransaction(async (tx, { scope, input }) =>
    publicEntity(
      await assignPostizChannels(tx, scope, postizAssignmentInput.parse(input)),
    ),
  ),
  "editorial-propose-brief": sharedTransaction(async (_tx, { input }) =>
    proposeBrief(briefProposalInput.parse(input)),
  ),
  "community-import": sharedTransaction((tx, { scope, input }) =>
    importCommunityQuestions(tx, scope, communityImportInput.parse(input)),
  ),
  "community-link": sharedTransaction((tx, { scope, input }) =>
    linkCommunityGroup(tx, scope, communityLinkInput.parse(input)),
  ),
  "adapt-content": sharedTransaction((tx, { scope, input }) =>
    adaptContent(tx, scope, contentAdaptationInput.parse(input)),
  ),
  "calendar-block": sharedTransaction((tx, { scope, input }) =>
    blockCalendar(tx, scope, calendarBlock.parse(input)),
  ),
  "calendar-unblock": sharedTransaction((tx, { scope, input }) =>
    unblockCalendar(
      tx,
      scope,
      schemas.id.parse(input.blockId),
      z.number().int().positive().parse(input.version),
    ),
  ),
  "slack-configure": sharedTransaction((tx, { scope, input }) =>
    configureSlack(tx, scope, slackConfiguration.parse(input)),
  ),
  "slack-digest": sharedTransaction((tx, { scope }) =>
    queueSlackDigest(tx, scope),
  ),
  "correct-metric": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        metricId: schemas.id,
        version: z.number().int(),
        values: schemas.metric,
        reason: z.string().min(5).max(500),
      })
      .strict()
      .parse(input);
    return correctMetric(tx, scope, i.metricId, i.version, i.values, i.reason);
  }),
  "memory-lifecycle": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        kind: z.enum(["preferences", "insights"]),
        id: schemas.id,
        version: z.number().int(),
        operation: z.enum(["disable", "delete"]),
      })
      .strict()
      .parse(input);
    return memoryLifecycle(tx, scope, i.kind, i.id, i.version, i.operation);
  }),
  "evaluate-experiment": sharedTransaction((tx, { scope, input }) =>
    evaluateExperiment(tx, scope, schemas.id.parse(input.experimentId)),
  ),
  "stop-experiment": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        experimentId: schemas.id,
        version: z.number().int(),
        reason: z.string().min(5).max(500),
      })
      .strict()
      .parse(input);
    return stopExperiment(tx, scope, i.experimentId, i.version, i.reason);
  }),
  "preference-update": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        preferenceId: schemas.id,
        version: z.number().int(),
        status: z.enum(["confirmed", "disabled"]),
        rule: z.string().min(1).max(2000).optional(),
      })
      .strict()
      .parse(input);
    const p = await entity(tx, scope, "preferences", i.preferenceId);
    if (p.version !== i.version) throw new DomainError("VERSION_CONFLICT", 409);
    return update(tx, scope, p, {
      ...data(p),
      status: i.status,
      rule: i.rule ?? data(p).rule,
      confirmedBy: scope.userId,
    });
  }),
  "import-metrics": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        csv: z.string().max(1000000),
        source: z.string().max(100).default("csv"),
        accountId: z.string().max(100).default("manual"),
        currency: z.string().regex(/^[A-Z]{3}$/),
        timezone: z.string(),
        columns: z.object({
          date: z.string(),
          campaignId: z.string(),
          impressions: z.string().optional(),
          clicks: z.string().optional(),
          spend: z.string().optional(),
          conversions: z.string().optional(),
        }),
      })
      .strict()
      .parse(input);
    const previous = await list(tx, scope, "metrics");
    const result = importAdsCsv(i.csv, {
      ...i,
      projectId: scope.projectId,
      existing: new Map(
        previous.map((x) => [data(x).externalId, data(x).contentHash]),
      ),
    });
    for (const row of result.rows) {
      const micros =
        row.spendMinor === null ? null : BigInt(row.spendMinor) * 10000n;
      if (micros !== null && micros > BigInt(Number.MAX_SAFE_INTEGER))
        throw new DomainError("MONEY_OUT_OF_RANGE");
      await create(tx, scope, "metrics", {
        ...row,
        externalId: row.key,
        campaign: row.campaignId,
        sampleSize: row.impressions ?? row.clicks ?? 0,
        sessions: null,
        costMicros:
          row.spendMinor === null
            ? null
            : Number(BigInt(row.spendMinor) * 10000n),
        periodStart: row.date + "T00:00:00.000Z",
        periodEnd: row.date + "T23:59:59.999Z",
        dateInterpretation: "source-local-calendar-day",
        synthetic: false,
      });
    }
    return result;
  }),
  "brand-approval": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        brandName: z.literal("EDS Labs"),
        confirmUsageRights: z.literal(true),
      })
      .strict()
      .parse(input);
    return publicEntity(
      await create(tx, scope, "assets", {
        type: "original_logo",
        brandName: i.brandName,
        usageApproved: true,
        assetStatus: "approved",
        sha256:
          "a652f47968922890004e279004986a01ec968ffead1f3fb1a70af5c3e37f423c",
        approvedBy: scope.userId,
        source: "EDS Labs local original",
        license: "Brand rights reserved",
      }),
    );
  }),
  "asset-status": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        assetId: schemas.id,
        version: z.number().int().positive(),
        assetStatus: z.enum(["approved", "reference", "outdated"]),
        confirmUsageRights: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const asset = await entity(tx, scope, "assets", i.assetId);
    if (asset.version !== i.version)
      throw new DomainError("VERSION_CONFLICT", 409);
    if (i.assetStatus === "approved" && i.confirmUsageRights !== true)
      throw new DomainError("ASSET_RIGHTS_CONFIRMATION_REQUIRED", 409);
    const updated = await update(tx, scope, asset, {
      ...data(asset),
      assetStatus: i.assetStatus,
      usageApproved:
        i.assetStatus === "approved" ? i.confirmUsageRights === true : false,
      assetStatusUpdatedBy: scope.userId,
      assetStatusUpdatedAt: new Date().toISOString(),
    });
    await audit(tx, scope, "asset.status_update", asset.id, {
      from: data(asset).assetStatus,
      to: i.assetStatus,
      usageApproved: data(updated).usageApproved,
    });
    return publicEntity(updated);
  }),
  reconcile: sharedTransaction(async (tx, { scope, input }) => {
    const pub = await entity(
      tx,
      scope,
      "publications",
      schemas.id.parse(input.publicationId),
    );
    return enqueue(
      tx,
      scope,
      "reconciliation",
      pub.id,
      "reconcile-manual:" + pub.id + ":" + pub.version,
    );
  }),
  "configure-matomo-schedule": sharedTransaction((tx, { scope, input }) =>
    configureMatomoSchedule(tx, scope, input),
  ),
  "configure-autopilot": sharedTransaction((tx, { scope, input }) =>
    configureAutopilot(tx, scope, input),
  ),
  "approve-and-schedule": sharedTransaction((tx, { scope, input }) =>
    approveAndSchedule(tx, scope, input),
  ),
  "resume-paused-publications": sharedTransaction((tx, { scope }) =>
    resumePausedPublications(tx, scope),
  ),
  "archive-mission": sharedTransaction((tx, { scope, input }) =>
    archiveMission(tx, scope, input),
  ),
  "archive-old-drafts": sharedTransaction((tx, { scope, input }) =>
    archiveOldDrafts(tx, scope, input),
  ),
  "restore-draft-cleanup": sharedTransaction((tx, { scope, input }) =>
    restoreDraftCleanup(tx, scope, input),
  ),
  "run-mission": sharedTransaction((tx, { scope, input }) =>
    planMission(tx, scope, schemas.id.parse(input.missionId)),
  ),
  "start-approved-live-draft-once": sharedTransaction(
    async (tx, { scope, input }) => {
      const i = z
        .object({
          missionId: schemas.id,
          version: z.number().int().positive(),
          confirmPaidInternalDraft: z.literal(true),
        })
        .strict()
        .parse(input);
      return startApprovedLiveDraftOnce(tx, scope, i.missionId, i.version);
    },
  ),
  "postiz-draft-resolve": sharedTransaction((tx, { scope, input }) =>
    resolvePostizDraft(tx, scope, input),
  ),
  "start-approved-live-draft-batch": sharedTransaction(
    async (tx, { scope, input }) => {
      const i = z
        .object({
          missionId: schemas.id,
          version: z.number().int().positive(),
          confirmPaidInternalDrafts: z
            .number()
            .int()
            .min(2)
            .max(MAX_BATCH_DRAFTS),
        })
        .strict()
        .parse(input);
      const mission = await entity(tx, scope, "missions", i.missionId);
      if (data(mission).maxContents !== i.confirmPaidInternalDrafts)
        throw new DomainError("BATCH_CONFIRMATION_STALE", 409);
      return startApprovedLiveDraftBatch(tx, scope, i.missionId, i.version);
    },
  ),
  "resume-live-draft-batch": sharedTransaction(async (tx, { scope, input }) => {
    const i = z
      .object({
        missionId: schemas.id,
        version: z.number().int().positive(),
        confirmPaidInternalDraft: z.literal(true),
      })
      .strict()
      .parse(input);
    return resumeLiveDraftBatch(tx, scope, i.missionId, i.version);
  }),
  review: sharedTransaction((tx, { scope, input }) =>
    reviewContent(
      tx,
      scope,
      schemas.id.parse(input.contentId),
      z.number().int().parse(input.version),
      input.humanConfirm === true,
    ),
  ),
  preflight: sharedTransaction(async (tx, { scope, input, config }) => {
    const p = await preflight(tx, scope, schemas.id.parse(input.contentId), {
      test: config.EXECUTION_MODE === "test",
    });
    return {
      allowed: p.allowed,
      blockers: p.blockers,
      packageHash: p.packageHash,
      contentVersion: p.content.version,
    };
  }),
  approve: sharedTransaction((tx, { scope, input }) =>
    approve(
      tx,
      scope,
      z
        .object({
          contentId: schemas.id,
          version: z.number().int(),
          packageHash: z.string().length(64),
        })
        .strict()
        .parse(input),
    ),
  ),
  publish: sharedTransaction((tx, { scope, input }) =>
    publishIntent(
      tx,
      scope,
      z
        .object({
          contentId: schemas.id,
          version: z.number().int(),
          scheduledAt: z.iso.datetime().optional(),
        })
        .strict()
        .parse(input),
    ),
  ),
  analyze: sharedTransaction((tx, { scope, input }) =>
    analyze(tx, scope, z.string().optional().parse(input.campaign)),
  ),
  retry: sharedTransaction(async (tx, { scope, input }) => {
    const job = await entity(tx, scope, "jobs", schemas.id.parse(input.jobId));
    if (
      !["failed", "blocked_dependency"].includes(data(job).status) ||
      data(job).attempts >= data(job).maxAttempts
    )
      throw new DomainError("RETRY_NOT_ALLOWED");
    if (data(job).topic === "publishing") {
      const p = await entity(tx, scope, "publications", data(job).resourceId);
      if (
        ["sending", "outcome_unknown", "published", "published_test"].includes(
          data(p).status,
        )
      )
        throw new DomainError("RECONCILIATION_REQUIRED");
    }
    await update(tx, scope, job, { ...data(job), status: "queued" });
    await tx.outbox.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        topic: data(job).topic,
        entityId: job.id,
        payload: { jobId: job.id },
      },
    });
    return { queued: true };
  }),
};
