import { z } from "zod";
import {
  openSecret,
  sealSecret,
} from "../../../platform/connections/secrets.ts";
import { YOUTUBE_API } from "../accounts/channel-oauth.ts";
import { socialFetch } from "../accounts/http.ts";
import { youtubeOptions } from "../posts/validation.ts";
import { providerStateStore } from "./provider-state-store.ts";
import type { SendInput, SendResult, SocialSender } from "./registry.ts";

const uploadOrigin = "https://www.googleapis.com";
const uploadPath = "/upload/youtube/v3/videos";
const videoId = /^[A-Za-z0-9_-]{11}$/;
const pending = (): SendResult => ({ kind: "processing", providerState: {} });
const unknown = (): SendResult => ({
  kind: "unknown",
  code: "SOCIAL_PROVIDER_UNKNOWN",
});
const failed = (): SendResult => ({
  kind: "failed",
  code: "SOCIAL_PROVIDER_REJECTED",
  retry: "never",
});
const wait = (code = "SOCIAL_PROVIDER_UNAVAILABLE"): SendResult => ({
  kind: "failed",
  code,
  retry: "after-delay",
  delayMs: 60_000,
});
const uploadUncertain = (): SendResult => ({
  kind: "failed",
  code: "SOCIAL_PROVIDER_UNAVAILABLE",
  retry: "after-delay",
  delayMs: 60_000,
  providerState: { youtubeUploadUncertain: true },
});
const authorization = (input: SendInput) => ({
  Authorization: `Bearer ${input.credentials.accessToken}`,
  Accept: "application/json",
});

function sessionUrl(value: string | null) {
  try {
    const url = new URL(value ?? "");
    if (
      url.origin === uploadOrigin &&
      url.pathname === uploadPath &&
      url.searchParams.get("upload_id") &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    return null;
  }
  return null;
}

function submissionFailure(response: Response): SendResult {
  if (response.status === 401)
    return {
      kind: "failed",
      code: "SOCIAL_PROVIDER_REJECTED",
      retry: "after-reconnect",
    };
  if (response.status === 429) return wait("SOCIAL_RATE_LIMITED");
  if (response.status >= 500 || response.status === 408) return wait();
  return failed();
}

const seal = z.object({ keyId: z.string(), ciphertext: z.string() });
const storedState = z.object({
  session: seal.nullable(),
  id: z.string().regex(videoId).optional(),
});

async function uploadedId(response: Response) {
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  return typeof body?.id === "string" && videoId.test(body.id) ? body.id : null;
}

function readOffset(response: Response, size: number) {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : Number.NaN;
  return Number.isSafeInteger(offset) && offset > 0 && offset < size
    ? offset
    : null;
}

async function queryUpload(url: string, input: SendInput, size: number) {
  return socialFetch(url, {
    method: "PUT",
    headers: {
      ...authorization(input),
      "Content-Length": "0",
      "Content-Range": `bytes */${size}`,
    },
  });
}

export const youtubeSender: SocialSender = {
  async send(scope, input) {
    const [video] = input.media;
    const options = youtubeOptions.safeParse(input.options);
    if (
      !video ||
      input.media.length !== 1 ||
      video.mime !== "video/mp4" ||
      !options.success
    )
      return failed();

    const size = video.bytes.byteLength;
    const store = providerStateStore(scope, "youtube-upload");
    let row = await store.read(input.publicationId);
    let url: string | null;
    try {
      if (!row) {
        // Starting a session does not create a video. Its URL is sealed
        // before the first byte is sent so any later retry can resume.
        const started = await socialFetch(
          `${uploadOrigin}${uploadPath}?uploadType=resumable&part=snippet%2Cstatus`,
          {
            method: "POST",
            headers: {
              ...authorization(input),
              "Content-Type": "application/json",
              "X-Upload-Content-Length": String(size),
              "X-Upload-Content-Type": video.mime,
            },
            body: JSON.stringify({
              snippet: {
                title: options.data.title,
                description: input.body,
                categoryId: "28",
              },
              status: {
                privacyStatus: options.data.privacy,
                selfDeclaredMadeForKids: options.data.madeForKids,
              },
            }),
          },
        );
        if (!started.ok) return submissionFailure(started);
        url = sessionUrl(started.headers.get("location"));
        if (!url) return failed();
        await store.create(input.publicationId, { session: sealSecret(url) });
        row = { revision: 0, body: {} };
      } else {
        const state = storedState.parse(row.body);
        if (state.id) return pending();
        url = state.session && sessionUrl(openSecret(state.session));
        if (!url) return unknown();
      }
    } catch {
      return wait();
    }

    const keepId = async (id: string) => {
      await store.update(input.publicationId, row.revision, {
        id,
        session: null,
      });
      return pending();
    };

    let sentBytes = false;
    try {
      // Always ask the same upload session which bytes were stored. A
      // completed response must be observed before we discard the session.
      const status = await queryUpload(url, input, size);
      if (status.status !== 308) {
        const id = await uploadedId(status);
        if (id) return await keepId(id);
        if (status.status === 404 || status.status === 410 || status.ok)
          return unknown();
        return submissionFailure(status);
      }
      const offset = readOffset(status, size);
      if (offset === null) return unknown();
      sentBytes = true;
      const result = await socialFetch(url, {
        method: "PUT",
        headers: {
          ...authorization(input),
          "Content-Type": video.mime,
          "Content-Length": String(size - offset),
          "Content-Range": `bytes ${offset}-${size - 1}/${size}`,
        },
        body: new Uint8Array(video.bytes.subarray(offset)),
        signal: AbortSignal.timeout(60_000),
      });
      if (result.status === 308) return wait();
      const id = await uploadedId(result);
      if (id) return await keepId(id);
      if (result.ok || result.status === 404 || result.status === 410)
        return unknown();
      if (result.status >= 500 || result.status === 408)
        return uploadUncertain();
      return submissionFailure(result);
    } catch {
      // Retrying queries Google's existing session before sending any bytes.
      return sentBytes ? uploadUncertain() : wait();
    }
  },

  async reconcile(scope, input) {
    const store = providerStateStore(scope, "youtube-upload");
    const row = await store.read(input.publicationId);
    if (!row) return { kind: "not_found" };
    const state = storedState.parse(row.body);
    let id = state.id;
    if (!id && state.session && input.media[0]) {
      const url = sessionUrl(openSecret(state.session));
      if (!url) return { kind: "not_found" };
      id =
        (await uploadedId(
          await queryUpload(url, input, input.media[0].bytes.byteLength),
        )) ?? undefined;
      if (id)
        await store.update(input.publicationId, row.revision, {
          id,
          session: null,
        });
    }
    if (!id) return { kind: "not_found" };
    const response = await socialFetch(
      `${YOUTUBE_API}/videos?part=status%2CprocessingDetails&id=${id}`,
      { headers: authorization(input) },
    );
    if (!response.ok) return pending();
    const body = await response.json().catch(() => null);
    const item = Array.isArray(body?.items)
      ? body.items.find((candidate: { id?: string }) => candidate?.id === id)
      : undefined;
    if (
      ["failed", "terminated"].includes(
        item?.processingDetails?.processingStatus,
      ) ||
      ["failed", "rejected", "deleted"].includes(item?.status?.uploadStatus)
    )
      return failed();
    if (
      item?.processingDetails?.processingStatus !== "succeeded" &&
      item?.status?.uploadStatus !== "processed"
    )
      return pending();
    const expected = youtubeOptions.safeParse(input.options);
    if (
      !expected.success ||
      item?.status?.privacyStatus !== expected.data.privacy
    )
      return { kind: "unknown", code: "SOCIAL_YOUTUBE_VISIBILITY_MISMATCH" };
    return {
      kind: "published",
      externalPostId: id,
      permalink: `https://www.youtube.com/watch?v=${id}`,
    };
  },
};
