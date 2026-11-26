import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { closeDatabase, scoped } from "../../../packages/db/src/index.ts";
import { setSocialFetchForTests } from "../src/modules/social/accounts/http.ts";
import {
  connectManualTikTok,
  TIKTOK_MANUAL,
} from "../src/modules/social/accounts/tiktok.ts";
import { providerStateStore } from "../src/modules/social/adapters/provider-state-store.ts";
import {
  senderFor,
  type SendInput,
} from "../src/modules/social/adapters/registry.ts";
import { deliverPublication } from "../src/modules/social/dispatch/deliver.ts";
import { dispatchPost } from "../src/modules/social/dispatch/dispatch.ts";
import { resolvePublication } from "../src/modules/social/dispatch/control.ts";
import {
  mediaContent,
  removeMedia,
  uploadMedia,
} from "../src/modules/social/media/library.ts";
import { publishNow } from "../src/modules/social/posts/approval.ts";
import { createPost, getPost } from "../src/modules/social/posts/posts.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import { decideActionRequest } from "../src/platform/governance/action-requests.ts";
import { data } from "../src/shared.ts";
import { createSocialProject } from "./support/social-project.ts";
import { videoFixture } from "./support/social-video.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const bytes = videoFixture();

describe.skipIf(!enabled)("company channel publishing", () => {
  let project: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  const objects = new Map<string, Uint8Array>();
  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_S3_ENDPOINT: "https://example.invalid",
      FILES_S3_BUCKET: "synthetic-social-storage",
      FILES_S3_ACCESS_KEY_ID: "synthetic",
      FILES_S3_SECRET_ACCESS_KEY: "synthetic",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    setObjectStoreForTests({
      async put(key, body) {
        objects.set(key, body);
      },
      async get(key) {
        return objects.get(key) ?? null;
      },
      async delete(key) {
        objects.delete(key);
      },
    }, "social-video");
    project = await createSocialProject();
    other = await createSocialProject();
  });

  afterEach(() => setSocialFetchForTests(null));
  afterAll(async () => {
    setObjectStoreForTests(null, "social-video");
    await project?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("stores and removes Social videos in S3 while existing file types use PostgreSQL", async () => {
    const photo = await uploadMedia(project.owner, {
      bytes: readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url)),
      mime: "image/png",
      name: "photo.png",
    });
    expect(objects.size).toBe(0);
    const asset = await uploadMedia(project.owner, {
      bytes,
      mime: "video/mp4",
      name: "demo.mp4",
    });
    const [key] = objects.keys();
    expect(objects.size).toBe(1);
    expect(key).toContain(`projects/${project.owner.projectId}/social/`);
    const blobs = await scoped(project.owner.workspaceId, project.owner.projectId, (tx) =>
      tx.fileBlob.findMany({ select: { key: true } }),
    );
    expect(blobs).toHaveLength(2);
    expect(blobs.some((blob) => blob.key === key)).toBe(false);
    expect((await mediaContent(project.owner, photo.id, "original")).mime).toBe("image/jpeg");
    expect(await removeMedia(project.owner, asset.id)).toMatchObject({ removed: "deleted" });
    expect(objects.has(key!)).toBe(false);
    await expect(mediaContent(project.owner, asset.id, "original")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps a TikTok post open after approval and only settles a link for the same profile", async () => {
    const storeBefore = objects.size;
    const asset = await uploadMedia(project.owner, {
      bytes,
      mime: "video/mp4",
      name: "demo.mp4",
    });
    expect(asset).toMatchObject({ durationMs: 1200, mime: "video/mp4" });
    expect(objects.size).toBe(storeBefore + 1);
    expect(
      [...objects.values()].some((value) => Buffer.from(value).equals(bytes)),
    ).toBe(false);
    expect(
      Buffer.from(
        (await mediaContent(project.viewer, asset.id, "original")).bytes,
      ),
    ).toEqual(bytes);
    await expect(
      mediaContent(other.owner, asset.id, "original"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      mediaContent(project.viewer, asset.id, "jpeg"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { accountId } = await connectManualTikTok(project.owner, {
      handle: "@eds",
    });
    const draft = await project.run((tx) =>
      createPost(tx, project.owner, {
        baseText: "New release",
        baseMedia: [asset.id],
        variants: [{ accountId }],
      }),
    );
    const requested = await project.run((tx) =>
      publishNow(tx, project.editor, draft.id, { version: draft.version }),
    );
    const id = requested.approval.requestId!;
    const entity = await project.run((tx) =>
      tx.entity.findUniqueOrThrow({ where: { id } }),
    );
    await project.run((tx) =>
      decideActionRequest(tx, project.owner, id, {
        version: entity.version,
        packageHash: data(entity).packageHash,
        decision: "approve",
      }),
    );
    const approved = await project.run((tx) =>
      getPost(tx, project.owner, draft.id),
    );
    await dispatchPost(project.owner, draft.id, approved.version);
    const dispatching = await project.run((tx) =>
      getPost(tx, project.owner, draft.id),
    );
    const publicationId = dispatching.publications[0]!.id;
    const transport = vi.fn();
    setSocialFetchForTests(transport);
    await deliverPublication(project.owner, publicationId);
    const waiting = await project.run((tx) =>
      getPost(tx, project.owner, draft.id),
    );
    expect(waiting.status).toBe("publishing");
    const publication = waiting.publications[0]!;
    expect(publication).toMatchObject({
      status: "blocked",
      blockedCode: TIKTOK_MANUAL,
    });
    const confirmation = {
      version: publication.version,
      resolution: "published_confirmed",
    };
    await expect(
      project.run((tx) =>
        resolvePublication(tx, project.owner, publicationId, {
          ...confirmation,
          permalink: "https://www.tiktok.com/@other/video/1234567890123",
        }),
      ),
    ).rejects.toMatchObject({ code: "SOCIAL_TIKTOK_PERMALINK_INVALID" });
    await expect(
      project.run((tx) =>
        resolvePublication(tx, project.owner, publicationId, {
          ...confirmation,
          permalink: "https://www.tiktok.com/@eds/video/1234567890123",
        }),
      ),
    ).resolves.toMatchObject({
      status: "published",
      externalPostId: "1234567890123",
      blockedCode: null,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("resumes YouTube from the confirmed byte offset and waits for processing", async () => {
    const id = "edsTest1234";
    const uploadUrl =
      "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic-session";
    const input: SendInput = {
      publicationId: randomUUID(),
      credentials: {
        platform: "youtube",
        accessToken: "synthetic",
        externalId: "UCtest",
        config: {},
      },
      account: { externalId: "UCtest", handle: "@eds", settings: {} },
      body: "Description",
      options: {
        title: "Private test",
        privacy: "private",
        madeForKids: false,
      },
      providerState: {},
      media: [
        {
          fileId: "video",
          bytes,
          width: 540,
          height: 960,
          mime: "video/mp4",
          publicUrl: null,
        },
      ],
    };
    let posted = 0;
    let uploaded = 0;
    let processed = false;
    const transport = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted += 1;
        expect(JSON.parse(String(init.body))).toMatchObject({
          status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
        });
        return new Response(null, {
          status: 200,
          headers: { location: uploadUrl },
        });
      }
      if (init?.method === "PUT") {
        const range = new Headers(init.headers).get("content-range");
        if (range?.startsWith("bytes */"))
          return new Response(null, {
            status: 308,
            headers: uploaded ? { range: "bytes=0-31" } : {},
          });
        uploaded += 1;
        if (uploaded === 1) throw new Error("simulated timeout after receiving 32 bytes");
        expect(range).toBe(`bytes 32-${bytes.length - 1}/${bytes.length}`);
        expect(init.body).toEqual(new Uint8Array(bytes.subarray(32)));
        return Response.json({ id });
      }
      expect(String(url)).toContain(id);
      return Response.json({
        items: [
          {
            id,
            processingDetails: {
              processingStatus: processed ? "succeeded" : "processing",
            },
            status: { privacyStatus: "private" },
          },
        ],
      });
    });
    setSocialFetchForTests(transport);
    const sender = senderFor("youtube")!;
    await expect(sender.send(project.owner, input)).resolves.toMatchObject({
      kind: "failed",
      retry: "after-delay",
      providerState: { youtubeUploadUncertain: true },
    });
    const state = await providerStateStore(
      project.owner,
      "youtube-upload",
    ).read(input.publicationId);
    expect(JSON.stringify(state)).not.toContain("synthetic-session");
    await expect(sender.send(project.owner, input)).resolves.toMatchObject({
      kind: "processing",
    });
    expect(posted).toBe(1);
    await expect(
      sender.reconcile!(project.owner, { ...input, since: new Date() }),
    ).resolves.toMatchObject({ kind: "processing" });
    processed = true;
    await expect(
      sender.reconcile!(project.owner, { ...input, since: new Date() }),
    ).resolves.toMatchObject({ kind: "published", externalPostId: id });
  });
});
