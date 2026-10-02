import { validateActiveIndexEvaluation } from "../../../../packages/knowledge/src/index.ts";
import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, list } from "../shared.ts";
import { isAssignedPostizChannel } from "./postiz-assignment.ts";
import { publicOpenAiConfiguration } from "./openai-configuration.ts";
import { currentMarketingProfile } from "./marketing-profile.ts";
import { actionReadiness } from "./action-readiness.ts";
import { loadConfig } from "../../../../packages/config/src/index.ts";
import { imagePriceConfigured } from "../../../../packages/ai/src/index.ts";
import {
  driveReconnectRequired,
  publishingUsesDriveAssets,
} from "./drive-readiness.ts";
export async function readiness(tx: DbTx, scope: Scope) {
  const project = await tx.project.findUniqueOrThrow({
      where: { id: scope.projectId },
    }),
    sources = await list(tx, scope, "sources"),
    facts = await list(tx, scope, "facts"),
    connectors = await list(tx, scope, "connectors"),
    policies = await list(tx, scope, "policies");
  const active = policies.find((p) => data(p).active),
    p = data(active),
    now = Date.now();
  const knowledge =
    sources.some(
      (s) =>
        data(s).status === "active" &&
        data(s).publicUse &&
        data(s).lastSuccessfulSyncAt &&
        now - Date.parse(data(s).lastSuccessfulSyncAt) <=
          data(s).maxAgeHours * 3600000,
    ) &&
    facts.some(
      (f) =>
        data(f).status === "verified" &&
        data(f).publicUse &&
        Date.parse(data(f).validFrom) <= now &&
        (!data(f).validUntil || Date.parse(data(f).validUntil) > now),
    );
  const policy = Boolean(
      active && Date.parse(p.startAt) <= now && Date.parse(p.endAt) > now,
    ),
    budget = Boolean(
      policy &&
      p.approvedPaidTests &&
      p.dailyBudgetMicros > 0 &&
      p.monthlyBudgetMicros > 0 &&
      p.perRunBudgetMicros > 0,
    );
  const openAi = publicOpenAiConfiguration(
      await tx.entity.findFirst({
        where: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "openai_configuration",
        },
      }),
    ),
    model = Boolean(openAi.configured && openAi.verifiedModels.length),
    evaluation = await validateActiveIndexEvaluation(tx, scope),
    evals = evaluation.valid;
  const publisher = connectors.find(
      (c) =>
        data(c).provider === "postiz" && data(c).status === "write_verified",
    ),
    matomo = connectors.find(
      (c) =>
        data(c).provider === "matomo" && data(c).status === "read_verified",
    );
  const driveConnection = (await list(tx, scope, "drive_connection"))[0],
    driveStorage = (await list(tx, scope, "drive_storage"))[0];
  // Recorded refresh state only; readiness never calls Google. Asset usage is
  // checked only when the connection is known to be broken.
  const driveReconnect = driveReconnectRequired(driveConnection),
    drivePublishing =
      driveReconnect && (await publishingUsesDriveAssets(tx, scope));
  const blockers = [
    ...(!knowledge ? ["CURRENT_PUBLIC_KNOWLEDGE_REQUIRED"] : []),
    ...(!policy ? ["OWNER_POLICY_REQUIRED"] : []),
    ...(!budget ? ["APPROVED_PAID_BUDGET_REQUIRED"] : []),
    ...(!model ? ["VERIFIED_OPENAI_MODELS_REQUIRED"] : []),
    ...(!evals ? ["LIVE_RAG_EVAL_REQUIRED"] : []),
    ...(!publisher ? ["PUBLISHER_WRITE_VERIFICATION_REQUIRED"] : []),
    ...(process.env.ENABLE_EXTERNAL_WRITES !== "true"
      ? ["EXTERNAL_WRITES_DISABLED"]
      : []),
    ...(publisher &&
    (!p.channels?.length ||
      !p.channels.every(
        (id: string) =>
          isAssignedPostizChannel(data(publisher), id) &&
          (data(publisher).writeVerifiedIntegrationIds ?? []).includes(id),
      ) ||
      data(publisher).writeVerifiedInstanceId !==
        process.env.PUBLISHER_INSTANCE_ID)
      ? ["CHANNEL_WRITE_VERIFICATION_REQUIRED"]
      : []),
    ...(drivePublishing ? ["GOOGLE_DRIVE_RECONNECT_REQUIRED"] : []),
    ...(project.paused ? ["PROJECT_PAUSED"] : []),
  ];
  const image = openAi.imageGeneration ?? {};
  const config = loadConfig();
  const postizConnector = connectors.find((c) => data(c).provider === "postiz");
  const postiz =
    postizConnector &&
    ["read_verified", "write_verified"].includes(data(postizConnector).status);
  const assignedChannels: string[] = postizConnector
    ? (data(postizConnector).assignedIntegrationIds ?? [])
    : [];
  const actions = actionReadiness({
    paused: project.paused,
    executionMode: process.env.EXECUTION_MODE,
    externalWritesEnabled: process.env.ENABLE_EXTERNAL_WRITES === "true",
    currentPublicKnowledge: knowledge,
    activePolicy: policy,
    paidMandate: budget,
    policyHasChannelsAndTypes: Boolean(
      policy && p.channels?.length && p.contentTypes?.length,
    ),
    marketingProfile: Boolean(await currentMarketingProfile(tx, scope)),
    textModelVerified: Boolean(
      openAi.textKeyConfigured && openAi.verifiedModels.length,
    ),
    imageKeyConfigured: openAi.imageKeyConfigured,
    imagePricingCurrent: imagePriceConfigured(image),
    imageModelVerified: Boolean(
      image.model && openAi.verifiedModels.includes(image.model),
    ),
    driveConfigured: Boolean(
      config.GOOGLE_DRIVE_CLIENT_ID && config.GOOGLE_DRIVE_CLIENT_SECRET,
    ),
    driveConnected: Boolean(
      driveConnection && data(driveConnection).encryptedRefreshToken,
    ),
    driveRootConfigured: Boolean(
      driveStorage &&
      data(driveStorage).rootFolderId &&
      data(driveStorage).enabled === true,
    ),
    driveReconnectRequired: driveReconnect,
    publishingUsesDriveAssets: drivePublishing,
    postizConnected: Boolean(postiz),
    postizChannelsAssigned: assignedChannels.length > 0,
    postizDraftsEnabled: process.env.ENABLE_POSTIZ_DRAFTS === "true",
    postizWriteVerified: Boolean(publisher),
    postizChannelWriteVerified: Boolean(
      publisher &&
      p.channels?.length &&
      p.channels.every(
        (id: string) =>
          isAssignedPostizChannel(data(publisher), id) &&
          (data(publisher).writeVerifiedIntegrationIds ?? []).includes(id),
      ) &&
      data(publisher).writeVerifiedInstanceId ===
        process.env.PUBLISHER_INSTANCE_ID,
    ),
    matomoReadVerified: Boolean(matomo),
  });
  return {
    actions,
    state:
      blockers.length === 0
        ? "live_ready"
        : knowledge && policy
          ? "test_ready"
          : sources.length
            ? "draft_ready"
            : "not_configured",
    blockers,
    capabilities: {
      knowledge: {
        state: knowledge
          ? "test_ready"
          : sources.length
            ? "draft_ready"
            : "not_configured",
      },
      generation: {
        state:
          model && budget && evals
            ? "live_ready"
            : knowledge
              ? "test_ready"
              : "not_configured",
      },
      social: {
        state:
          blockers.length === 0
            ? "live_ready"
            : policy && knowledge
              ? "test_ready"
              : "draft_ready",
      },
      blog: {
        state: knowledge ? "draft_ready" : "not_configured",
        liveBlocker: "BLOG_TARGET_NOT_CONFIGURED",
      },
      newsletter: {
        state: "draft_ready",
        liveBlocker: "MAIL_PROVIDER_NOT_CONFIGURED",
      },
      ads: {
        state: "draft_ready",
        liveBlocker: "ADS_WRITE_MANDATE_NOT_CONFIGURED",
      },
      analytics: { state: matomo ? "live_ready" : "draft_ready" },
      slack: {
        state: connectors.some(
          (c) =>
            data(c).provider === "slack" && data(c).status === "write_verified",
        )
          ? "live_ready"
          : "not_configured",
      },
    },
  };
}
