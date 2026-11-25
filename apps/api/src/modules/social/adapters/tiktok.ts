import { socialFetch } from "../accounts/http.ts";
import type { SendInput, SendResult, SocialSender } from "./registry.ts";

const api = "https://open.tiktokapis.com/v2/post/publish";
const manual = (): SendResult => ({ kind: "manual" });
const pending = (id: string): SendResult => ({
  kind: "processing",
  providerState: { tiktokInboxId: id },
});

function allowedUpload(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://open-upload.tiktokapis.com" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/video/")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

async function request(
  input: SendInput,
  path: string,
  body: Record<string, unknown>,
) {
  const response = await socialFetch(`${api}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.credentials.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  return json?.error?.code === "ok" ? json.data : null;
}

export const tiktokSender: SocialSender = {
  async send(_scope, input) {
    if (input.credentials.config.inbox !== true) return manual();
    const [video] = input.media;
    if (!video || input.media.length !== 1 || video.mime !== "video/mp4")
      return manual();
    const size = video.bytes.byteLength;
    let id: string | undefined;
    try {
      const started = await request(input, "/inbox/video/init/", {
        source_info: {
          source: "FILE_UPLOAD",
          video_size: size,
          chunk_size: size,
          total_chunk_count: 1,
        },
      });
      const url = allowedUpload(started?.upload_url);
      if (
        typeof started?.publish_id !== "string" ||
        !/^[\w.:-]{1,200}$/.test(started.publish_id) ||
        !url
      )
        return manual();
      id = started.publish_id;
      await socialFetch(url, {
        method: "PUT",
        signal: AbortSignal.timeout(60_000),
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(size),
          "Content-Range": `bytes 0-${size - 1}/${size}`,
        },
        body: new Uint8Array(video.bytes),
      });
      return pending(id!);
    } catch {
      // Status is read using the existing ID. Nothing uploads a second copy.
      return id ? pending(id) : manual();
    }
  },
  async reconcile(_scope, input) {
    const id = input.providerState.tiktokInboxId;
    if (typeof id !== "string") return manual();
    try {
      const data = await request(input, "/status/fetch/", { publish_id: id });
      if (["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"].includes(data?.status))
        return { kind: "manual", providerState: { tiktokInboxReady: true } };
      if (data?.status === "FAILED") return manual();
      return pending(id);
    } catch {
      return pending(id);
    }
  },
};
