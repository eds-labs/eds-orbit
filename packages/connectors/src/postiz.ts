import { z } from "zod";
import { assertMediaBytes } from "./media.ts";
import { ConnectorError, jsonTransport, type HttpOptions } from "./http.ts";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const safeRecord = z.record(z.string().max(100), z.unknown());
const mediaSchema = z.object({
  id,
  path: z
    .url()
    .refine((value) => new URL(value).protocol === "https:", "HTTPS required"),
});
const integrationSchema = z.object({
  id,
  name: z.string().min(1).max(500),
  identifier: z.string().min(1).max(100),
  disabled: z.boolean(),
  profile: z.string().max(2_000).nullable().optional(),
  customer: z
    .object({ id, name: z.string().max(500) })
    .nullable()
    .optional(),
});
const groupSchema = z.object({ id, name: z.string().min(1).max(500) });
const remoteSchema = z.object({
  id,
  state: z.string().min(1).max(100),
  publishDate: z.string(),
  integration: z.object({
    id,
    providerIdentifier: z.string().max(100).optional(),
  }),
  releaseURL: z.string().nullable().optional(),
  releaseId: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});
const analyticsSchema = z
  .array(
    z.object({
      label: z.string().min(1).max(200),
      data: z
        .array(
          z.object({
            total: z.union([z.string(), z.number()]),
            date: z.string().max(100),
          }),
        )
        .max(10_000),
      percentageChange: z.number().nullable().optional(),
    }),
  )
  .max(1_000);
const settingsSchema = z.object({
  output: z.object({
    rules: z.string().max(20_000).optional(),
    maxLength: z.number().int().positive().max(1_000_000).optional(),
    settings: safeRecord.optional(),
    tools: z
      .array(
        z.object({
          methodName: z.string().min(1).max(100),
          description: z.string().max(2_000).optional(),
          dataSchema: z.array(safeRecord).max(100).optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
});
const createSchema = z
  .object({
    type: z.enum(["draft", "schedule", "now"]),
    date: z.iso.datetime(),
    shortLink: z.boolean().default(false),
    tags: z
      .array(z.object({ id, value: z.string().max(100) }).strict())
      .max(20)
      .default([]),
    posts: z
      .array(
        z
          .object({
            integration: z.object({ id }).strict(),
            value: z
              .array(
                z
                  .object({
                    content: z.string().min(1).max(50_000),
                    image: z.array(mediaSchema).max(10).default([]),
                  })
                  .strict(),
              )
              .min(1)
              .max(20),
            settings: safeRecord.refine(
              (value) =>
                typeof value.__type === "string" &&
                /^[a-z][a-z0-9-]{0,50}$/.test(value.__type),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export type SocialChannel = z.infer<typeof integrationSchema>;
export type SocialGroup = z.infer<typeof groupSchema>;
export type SocialPost = z.infer<typeof remoteSchema>;
export type SocialMediaAsset = z.infer<typeof mediaSchema>;
export type SocialAnalytics = z.infer<typeof analyticsSchema>;
export type SocialProviderSettings = z.infer<typeof settingsSchema>["output"];
export type SocialPostStatus =
  "DRAFT" | "QUEUE" | "PUBLISHED" | "ERROR" | "UNKNOWN" | string;
export type PostizCreateInput = z.input<typeof createSchema>;

function validated<T>(
  schema: z.ZodType<T>,
  value: unknown,
  written = false,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ConnectorError(
      "INVALID_PROVIDER_RESPONSE",
      written ? "unknown" : "rejected",
    );
  return result.data;
}
function validId(value: string) {
  if (!id.safeParse(value).success)
    throw new ConnectorError("INVALID_REMOTE_ID");
  return value;
}
function jsonBody(value: unknown): RequestInit {
  return {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

/** Accept a host, legacy /public/v1, or canonical /api/public/v1 without duplicating the API prefix. */
export function normalizePostizBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ConnectorError("INVALID_ENDPOINT");
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/(?:\/api)?\/public\/v1(?:\/public\/v1)*$/, "");
  url.pathname = `${path}/api/public/v1`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

export const postizCapabilities = {
  listIntegrations: true,
  listGroups: true,
  providerSettings: true,
  providerTools: true,
  readStatusByDateRange: true,
  createDraft: true,
  schedule: true,
  publishNow: true,
  uploadMedia: true,
  changeStatus: true,
  updateSettings: true,
  analytics: true,
  releaseIdReconciliation: true,
  delete: "single_or_group_version_dependent",
  providerIdempotency: false,
  receiptProvesPublication: false,
} as const;

/** Call writes only from an executor that just checked the complete action package. */
export function createPostizClient(options: HttpOptions) {
  const baseUrl = normalizePostizBaseUrl(options.baseUrl);
  const call = jsonTransport({ ...options, baseUrl });
  async function listPosts(range: { startDate: string; endDate: string }) {
    if (
      !z.iso.datetime().safeParse(range.startDate).success ||
      !z.iso.datetime().safeParse(range.endDate).success ||
      Date.parse(range.endDate) < Date.parse(range.startDate) ||
      Date.parse(range.endDate) - Date.parse(range.startDate) > 32 * 86400_000
    )
      throw new ConnectorError("INVALID_DATE_RANGE");
    return validated(
      z.object({ posts: z.array(remoteSchema).max(10_000) }),
      await call(`posts?${new URLSearchParams(range)}`),
    ).posts;
  }
  return {
    baseUrl,
    capabilities: postizCapabilities,
    async listIntegrations() {
      return validated(
        z.array(integrationSchema).max(1_000),
        await call("integrations"),
      );
    },
    async listGroups() {
      return validated(z.array(groupSchema).max(1_000), await call("groups"));
    },
    async testConnection() {
      const channels = await this.listIntegrations();
      return {
        connected: true as const,
        provider: "postiz" as const,
        baseUrl,
        channelCount: channels.length,
        checkedAt: new Date().toISOString(),
        error: null,
      };
    },
    async healthcheck() {
      const result = await this.testConnection();
      return { status: "read_verified" as const, checkedAt: result.checkedAt };
    },
    async getIntegrationSettings(integrationId: string) {
      validId(integrationId);
      return validated(
        settingsSchema,
        await call(`integration-settings/${encodeURIComponent(integrationId)}`),
      ).output;
    },
    async triggerIntegrationTool(
      integrationId: string,
      input: { methodName: string; data: Record<string, unknown> },
    ) {
      validId(integrationId);
      const parsed = z
        .object({
          methodName: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
          data: safeRecord,
        })
        .strict()
        .parse(input);
      return await call(
        `integration-trigger/${encodeURIComponent(integrationId)}`,
        { method: "POST", ...jsonBody(parsed) },
        true,
      );
    },
    async createPost(input: PostizCreateInput) {
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) throw new ConnectorError("INVALID_POST_PAYLOAD");
      if (
        parsed.data.type === "schedule" &&
        Date.parse(parsed.data.date) <= Date.now()
      )
        throw new ConnectorError("SCHEDULE_IN_PAST");
      if (JSON.stringify(parsed.data).length > 500_000)
        throw new ConnectorError("POST_TOO_LARGE");
      const result = validated(
        z.array(z.object({ postId: id, integration: id })).min(1),
        await call("posts", { method: "POST", ...jsonBody(parsed.data) }, true),
        true,
      );
      const expected = parsed.data.posts.map((item) => item.integration.id);
      if (
        result.length !== expected.length ||
        result.some((item) => !expected.includes(item.integration)) ||
        new Set(result.map((item) => item.postId)).size !== result.length ||
        new Set(result.map((item) => item.integration)).size !==
          new Set(expected).size
      )
        throw new ConnectorError("INCOMPLETE_WRITE_RECEIPT", "unknown");
      return {
        remotePosts: result,
        state: "accepted" as const,
        requestedType: parsed.data.type,
      };
    },
    listPosts,
    async findPostStatus(
      remoteId: string,
      range: { startDate: string; endDate: string },
    ) {
      validId(remoteId);
      const post = (await listPosts(range)).find(
        (item) => item.id === remoteId,
      );
      return post
        ? { found: true as const, post }
        : { found: false as const, state: "outcome_unknown" as const };
    },
    async deletePost(
      remoteId: string,
      acknowledgement: { allowGroupDelete: true },
    ) {
      validId(remoteId);
      if (acknowledgement?.allowGroupDelete !== true)
        throw new ConnectorError("GROUP_DELETE_ACK_REQUIRED");
      const result = validated(
        z.object({ id }),
        await call(
          `posts/${encodeURIComponent(remoteId)}`,
          { method: "DELETE" },
          true,
        ),
        true,
      );
      return {
        remoteId: result.id,
        state: "deletion_acknowledged" as const,
        scope: "whole_group" as const,
      };
    },
    async changePostStatus(remoteId: string, status: "draft" | "schedule") {
      validId(remoteId);
      return validated(
        z.object({ id, state: z.enum(["DRAFT", "QUEUE"]) }),
        await call(
          `posts/${encodeURIComponent(remoteId)}/status`,
          { method: "PUT", ...jsonBody({ status }) },
          true,
        ),
        true,
      );
    },
    async updatePostSettings(
      remoteId: string,
      settings: Record<string, unknown>,
    ) {
      validId(remoteId);
      const parsed = safeRecord.parse(settings);
      return await call(
        `posts/${encodeURIComponent(remoteId)}/settings`,
        { method: "PUT", ...jsonBody({ settings: parsed }) },
        true,
      );
    },
    async getIntegrationAnalytics(integrationId: string) {
      validId(integrationId);
      return validated(
        analyticsSchema,
        await call(`analytics/${encodeURIComponent(integrationId)}`),
      );
    },
    async getPostAnalytics(remoteId: string) {
      validId(remoteId);
      return validated(
        analyticsSchema,
        await call(`analytics/post/${encodeURIComponent(remoteId)}`),
      );
    },
    async getMissingPostContent(remoteId: string) {
      validId(remoteId);
      return validated(
        z
          .array(z.object({ id: z.string().min(1).max(500), url: z.url() }))
          .max(1_000),
        await call(`posts/${encodeURIComponent(remoteId)}/missing`),
      );
    },
    async connectMissingReleaseId(remoteId: string, releaseId: string) {
      validId(remoteId);
      const release = z.string().min(1).max(500).parse(releaseId);
      return validated(
        z.object({ id, releaseId: z.string() }),
        await call(
          `posts/${encodeURIComponent(remoteId)}/release-id`,
          { method: "PUT", ...jsonBody({ releaseId: release }) },
          true,
        ),
        true,
      );
    },
    async uploadMedia(file: {
      bytes: Uint8Array;
      mime: string;
      filename: string;
    }) {
      if (
        ![
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "video/mp4",
        ].includes(file.mime) ||
        file.bytes.length === 0 ||
        file.bytes.length > 20 * 1024 * 1024 ||
        !/^[A-Za-z0-9_.-]{1,160}$/.test(file.filename)
      )
        throw new ConnectorError("INVALID_MEDIA");
      assertMediaBytes(file.bytes, file.mime);
      const form = new FormData();
      form.set(
        "file",
        new Blob([Uint8Array.from(file.bytes)], { type: file.mime }),
        file.filename,
      );
      return validated(
        mediaSchema,
        await call("upload", { method: "POST", body: form }, true),
        true,
      );
    },
  };
}
