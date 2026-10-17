import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import {
  fileCleanup,
  setObjectStoreForTests,
  storeFile,
} from "../src/platform/files/files.ts";
import { readFile, deleteFile } from "../src/platform/files/files.ts";
import { s3Store, signS3Request } from "../src/platform/files/s3.ts";
import { setModuleEnabled } from "../src/platform/modules/activation.ts";
import { moduleRegistry } from "../src/modules/registry.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

const BUCKET = {
  endpoint: "https://files.example.invalid",
  bucket: "orbit-files-test",
  region: "auto",
  accessKeyId: "synthetic-access-key",
  secretAccessKey: "synthetic-secret-key",
};
const FILES_ENV = {
  ORBIT_FILES: "true",
  FILES_BACKEND: "s3",
  FILES_S3_ENDPOINT: BUCKET.endpoint,
  FILES_S3_BUCKET: BUCKET.bucket,
  FILES_S3_ACCESS_KEY_ID: BUCKET.accessKeyId,
  FILES_S3_SECRET_ACCESS_KEY: BUCKET.secretAccessKey,
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  FILES_MAX_BYTES: String(64 * 1024),
};
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);

/**
 * An S3 bucket in memory that accepts a request only when its Signature
 * Version 4 matches the configured credentials, and can fail on purpose.
 */
function bucketDouble() {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; key: string }[] = [];
  let failDeletes = false;
  const fetch = async (url: string, init: RequestInit) => {
    const target = new URL(url);
    const headers = init.headers as Record<string, string>;
    const body = init.body
      ? Buffer.from(init.body as Uint8Array)
      : Buffer.alloc(0);
    const expected = signS3Request({
      method: init.method!,
      url: target,
      // As transmitted: fetch adds the length of a body itself.
      headers: {
        ...Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) =>
              !["authorization", "x-amz-date", "x-amz-content-sha256"].includes(
                name,
              ),
          ),
        ),
        ...(init.body ? { "content-length": String(body.byteLength) } : {}),
      },
      payloadHash: createHash("sha256").update(body).digest("hex"),
      accessKeyId: BUCKET.accessKeyId,
      secretAccessKey: BUCKET.secretAccessKey,
      region: BUCKET.region,
      now: new Date(
        headers["x-amz-date"]!.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
          "$1-$2-$3T$4:$5:$6Z",
        ),
      ),
    });
    if (expected.authorization !== headers.authorization)
      return new Response(null, { status: 403 });
    const prefix = `/${BUCKET.bucket}/`;
    if (!target.pathname.startsWith(prefix))
      return new Response(null, { status: 404 });
    const key = target.pathname.slice(prefix.length);
    requests.push({ method: init.method!, key });
    if (init.method === "PUT") {
      objects.set(key, body);
      return new Response(null, { status: 200 });
    }
    if (init.method === "DELETE") {
      if (failDeletes) return new Response(null, { status: 500 });
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const object = objects.get(key);
    return object
      ? new Response(new Uint8Array(object), { status: 200 })
      : new Response(null, { status: 404 });
  };
  return {
    objects,
    requests,
    failDeletes: (on: boolean) => {
      failDeletes = on;
    },
    store: s3Store(BUCKET, { fetch }),
  };
}

/**
 * Platform files (WP4.6): encrypted objects in their own bucket, metadata
 * under row-level security, reachable only through the authorized routes.
 */
describe.skipIf(!enabled)("platform files", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId = "";
  let projectId = "";
  let otherProjectId = "";
  const ids = { owner: "", editor: "", viewer: "" };
  const cookies = { owner: "", editor: "", viewer: "" };
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const bucket = bucketDouble();
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const upload = (
    who: keyof typeof ids,
    body: Buffer,
    options: {
      type?: string;
      module?: string;
      project?: string;
      name?: string;
    } = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${options.project ?? projectId}/files?module=${options.module ?? "knowledge"}`,
      headers: {
        origin,
        cookie: cookies[who],
        [CLIENT_IP_HEADER]: ip(),
        "content-type": "application/octet-stream",
        "x-file-type": options.type ?? "image/png",
        "x-file-name": encodeURIComponent(options.name ?? "logo.png"),
      },
      payload: body,
    });
  const call = (
    who: keyof typeof ids,
    method: "GET" | "DELETE",
    fileId: string,
    project = projectId,
  ) =>
    app.inject({
      method,
      url: `/api/projects/${project}/files/${fileId}`,
      headers: { origin, cookie: cookies[who], [CLIENT_IP_HEADER]: ip() },
    });
  const owner = () => ({
    workspaceId,
    projectId,
    userId: ids.owner,
    role: "owner" as const,
  });

  beforeAll(async () => {
    Object.assign(process.env, FILES_ENV);
    setObjectStoreForTests(bucket.store);
    app = await buildServer();
    const accounts: Record<string, { email: string; password: string }> = {};
    for (const who of ["owner", "editor", "viewer"] as const) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const created = await makeAuth().api.signUpEmail({
        body: { email, name: `Synthetic ${who}`, password },
      });
      ids[who] = created.user.id;
      users.push(created.user.id);
      accounts[who] = { email, password };
    }
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic files",
        members: {
          create: [
            { userId: ids.owner, role: "owner" },
            { userId: ids.editor, role: "viewer" },
            { userId: ids.viewer, role: "viewer" },
          ],
        },
      },
    });
    workspaceId = workspace.id;
    workspaces.push(workspace.id);
    projectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic files" },
      })
    ).id;
    otherProjectId = (
      await authDb.project.create({
        data: { workspaceId, name: "Synthetic files, other" },
      })
    ).id;
    for (const [who, role] of [
      ["editor", "editor"],
      ["viewer", "viewer"],
    ] as const)
      await authDb.projectMember.create({
        data: { workspaceId, projectId, userId: ids[who], role },
      });
    for (const who of ["owner", "editor", "viewer"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin, [CLIENT_IP_HEADER]: ip() },
        payload: accounts[who],
      });
      expect(response.statusCode).toBe(200);
      const set = response.headers["set-cookie"];
      cookies[who] = (Array.isArray(set) ? set : [set])
        .map((v) => v!.split(";")[0])
        .join("; ");
    }
  });
  afterEach(() => {
    Object.assign(process.env, FILES_ENV);
    delete process.env.ORBIT_MODULES;
    bucket.failDeletes(false);
  });
  afterAll(async () => {
    for (const name of Object.keys(FILES_ENV)) delete process.env[name];
    setObjectStoreForTests(null);
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  it("stores encrypted, returns the same bytes, and deletes object and row", async () => {
    const stored = await upload("editor", PNG, {
      name: "../../Brand Logo.png",
    });
    expect(stored.statusCode).toBe(201);
    const file = stored.json();
    expect(file).toMatchObject({
      moduleId: "knowledge",
      name: "Brand Logo.png",
      mime: "image/png",
      size: PNG.byteLength,
      sha256: createHash("sha256").update(PNG).digest("hex"),
    });
    expect(file.key).toBeUndefined();
    // The object holds neither the content nor the name, under a neutral key.
    const [key, object] = [...bucket.objects.entries()].at(-1)!;
    expect(key).toBe(`projects/${projectId}/knowledge/${file.id}`);
    expect(object.includes(PNG.subarray(8, 40))).toBe(false);

    const download = await call("viewer", "GET", file.id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(PNG)).toBe(true);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);

    expect((await call("viewer", "DELETE", file.id)).statusCode).toBe(403);
    expect((await call("editor", "DELETE", file.id)).statusCode).toBe(200);
    expect(bucket.objects.has(key)).toBe(false);
    expect((await call("owner", "GET", file.id)).statusCode).toBe(404);
    const rows = await scoped(workspaceId, projectId, (tx) =>
      tx.file.count({ where: { id: file.id } }),
    );
    expect(rows).toBe(0);
  });

  it("enforces size, type, signature and the module's write access", async () => {
    expect((await upload("viewer", PNG)).statusCode).toBe(403);
    expect(
      (
        await upload("editor", Buffer.alloc(65 * 1024, 1), {
          type: "text/plain",
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (await upload("editor", Buffer.from("<svg/>"), { type: "image/svg+xml" }))
        .statusCode,
    ).toBe(415);
    // A PNG type with other content.
    expect(
      (await upload("editor", Buffer.from("not a png"), { type: "image/png" }))
        .statusCode,
    ).toBe(415);
    expect((await upload("editor", Buffer.alloc(0))).statusCode).toBe(400);
    expect(
      (await upload("editor", PNG, { module: "unknown_module" })).statusCode,
    ).toBe(409);
    // A switched-off module takes no files.
    process.env.ORBIT_MODULES = "true";
    expect(
      (await upload("editor", PNG, { module: "marketing" })).statusCode,
    ).toBe(201);
    await scoped(workspaceId, projectId, (tx) =>
      setModuleEnabled(tx, owner(), moduleRegistry(), "marketing", false),
    );
    const refused = await upload("editor", PNG, { module: "marketing" });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe("MODULE_DISABLED");
    await scoped(workspaceId, projectId, (tx) =>
      setModuleEnabled(tx, owner(), moduleRegistry(), "marketing", true),
    );
  });

  it("keeps another project's files unreachable", async () => {
    const theirs = await storeFile(
      { ...owner(), projectId: otherProjectId },
      { moduleId: "knowledge", bytes: PNG, mime: "image/png" },
    );
    // The owner is a workspace owner, but the file is not this project's.
    expect((await call("owner", "GET", theirs.id)).statusCode).toBe(404);
    expect((await call("owner", "DELETE", theirs.id)).statusCode).toBe(404);
    // And members of this project are no members there.
    expect(
      (await call("editor", "GET", theirs.id, otherProjectId)).statusCode,
    ).toBe(404);
  });

  it("refuses a changed, swapped or missing object", async () => {
    const one = await storeFile(owner(), {
      moduleId: "knowledge",
      bytes: PNG,
      mime: "image/png",
    });
    const two = await storeFile(owner(), {
      moduleId: "knowledge",
      bytes: Buffer.from("plain text"),
      mime: "text/plain",
    });
    const keyOf = (id: string) => `projects/${projectId}/knowledge/${id}`;
    // Another file's object under this key: the file id is bound in.
    bucket.objects.set(keyOf(one.id), bucket.objects.get(keyOf(two.id))!);
    expect((await call("owner", "GET", one.id)).statusCode).toBe(500);
    const audits = await scoped(workspaceId, projectId, (tx) =>
      tx.auditEvent.count({ where: { action: "file.integrity_failed" } }),
    );
    expect(audits).toBe(1);
    bucket.objects.delete(keyOf(two.id));
    expect((await call("owner", "GET", two.id)).statusCode).toBe(404);
  });

  it("retries a failed object removal in the hourly cleanup", async () => {
    const file = await storeFile(owner(), {
      moduleId: "knowledge",
      bytes: PNG,
      mime: "image/png",
    });
    bucket.failDeletes(true);
    expect((await call("owner", "DELETE", file.id)).statusCode).toBe(200);
    // Gone for readers at once, object still there.
    expect((await call("owner", "GET", file.id)).statusCode).toBe(404);
    const key = `projects/${projectId}/knowledge/${file.id}`;
    expect(bucket.objects.has(key)).toBe(true);
    bucket.failDeletes(false);
    await fileCleanup.run(owner());
    expect(bucket.objects.has(key)).toBe(false);
    const rows = await scoped(workspaceId, projectId, (tx) =>
      tx.file.count({ where: { id: file.id } }),
    );
    expect(rows).toBe(0);
  });

  it("does not exist while off or without a bucket", async () => {
    process.env.ORBIT_FILES = "false";
    expect((await upload("owner", PNG)).statusCode).toBe(404);
    process.env.ORBIT_FILES = "true";
    delete process.env.FILES_S3_BUCKET;
    expect((await upload("owner", PNG)).statusCode).toBe(404);
    await expect(
      storeFile(owner(), {
        moduleId: "knowledge",
        bytes: PNG,
        mime: "image/png",
      }),
    ).rejects.toThrow("FILES_NOT_CONFIGURED");
  });
});

/**
 * The database backend (Mario 2026-10-17): the same encrypted objects in
 * `FileBlob`, scoped to their project, gone with the file and the project.
 */
describe.skipIf(!enabled)("platform files in the database", () => {
  const workspaces: string[] = [];
  let scope: {
    workspaceId: string;
    projectId: string;
    userId: string;
    role: "owner";
  };
  let other: typeof scope;
  const blobs = (s: typeof scope) =>
    scoped(s.workspaceId, s.projectId, (tx) => tx.fileBlob.findMany());

  beforeAll(async () => {
    setObjectStoreForTests(null);
    Object.assign(process.env, {
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: FILES_ENV.FILES_ENCRYPTION_KEY,
      FILES_MAX_BYTES: String(64 * 1024),
    });
    for (const name of [
      "FILES_S3_ENDPOINT",
      "FILES_S3_BUCKET",
      "FILES_S3_ACCESS_KEY_ID",
      "FILES_S3_SECRET_ACCESS_KEY",
    ])
      delete process.env[name];
    const make = async () => {
      const workspace = await authDb.workspace.create({
        data: { name: "Synthetic file blobs" },
      });
      workspaces.push(workspace.id);
      const project = await authDb.project.create({
        data: { workspaceId: workspace.id, name: "Synthetic file blobs" },
      });
      return {
        workspaceId: workspace.id,
        projectId: project.id,
        userId: "setup",
        role: "owner" as const,
      };
    };
    scope = await make();
    other = await make();
  });
  afterAll(async () => {
    for (const name of [
      "ORBIT_FILES",
      "FILES_BACKEND",
      "FILES_ENCRYPTION_KEY",
      "FILES_MAX_BYTES",
    ])
      delete process.env[name];
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await closeDatabase();
  });

  it("needs only the encryption key, stores encrypted and reads back", async () => {
    const file = await storeFile(scope, {
      moduleId: "knowledge",
      bytes: PNG,
      mime: "image/png",
      name: "logo.png",
    });
    const [blob] = await blobs(scope);
    expect(blob!.key).toBe(`projects/${scope.projectId}/knowledge/${file.id}`);
    // Encrypted at rest: no plaintext bytes in the row.
    expect(Buffer.from(blob!.data).includes(PNG.subarray(8, 40))).toBe(false);
    const read = await readFile(scope, file.id);
    expect(Buffer.from(read.bytes).equals(PNG)).toBe(true);
    // Another project sees neither the file nor its blob.
    await expect(readFile(other, file.id)).rejects.toThrow("NOT_FOUND");
    expect(await blobs(other)).toHaveLength(0);
    await deleteFile(scope, file.id);
    expect(await blobs(scope)).toHaveLength(0);
  });

  it("keeps blobs to their own project, and they go with it", async () => {
    // A key of another project is refused by the store and by the database.
    const { databaseStore } = await import("../src/platform/files/db-store.ts");
    await expect(
      databaseStore(scope).put(
        `projects/${other.projectId}/knowledge/x`,
        new Uint8Array([1]),
      ),
    ).rejects.toThrow("OBJECT_KEY_INVALID");
    await storeFile(other, {
      moduleId: "knowledge",
      bytes: Buffer.from("text"),
      mime: "text/plain",
    });
    expect(await blobs(other)).toHaveLength(1);
    await authDb.project.delete({ where: { id: other.projectId } });
    // The project's scope still names its id; nothing is left under it.
    expect(await blobs(other)).toHaveLength(0);
  });
});
