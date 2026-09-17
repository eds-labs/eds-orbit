/** Local synthetic acceptance only. This script never drops databases or starts a publisher. */
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient, scoped } from "../packages/db/src/index.js";
import {
  ingest,
  revokeDocument,
  revokeSource,
  retrieve,
  getActiveIndex,
} from "../packages/knowledge/src/index.js";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return new URL(value);
};
const source = required("TEST_MIGRATION_DATABASE_URL"),
  appUrl = required("TEST_DATABASE_URL"),
  authUrl = required("TEST_AUTH_DATABASE_URL");
for (const url of [source, appUrl, authUrl])
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/orbit_test"
  )
    throw new Error(
      "Restore acceptance is restricted to 127.0.0.1:55432/orbit_test",
    );
const suffix = process.env.ORBIT_RESTORE_TEST_SUFFIX ?? "";
if (suffix && !/^[a-z0-9_]{1,24}$/.test(suffix))
  throw new Error("Invalid local restore suffix");
const targetDatabase = "orbit_restore_test" + (suffix ? "_" + suffix : "");
const target = new URL(source);
target.pathname = "/" + targetDatabase;
const targetApp = new URL(appUrl);
targetApp.pathname = target.pathname;
const targetAuth = new URL(authUrl);
targetAuth.pathname = target.pathname;
const admin = new Client({ connectionString: source.toString() }),
  auth = createClient(authUrl.toString()),
  app = createClient(appUrl.toString());
let restored: ReturnType<typeof createClient> | undefined;
try {
  await admin.connect();
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname=$1",
    [targetDatabase],
  );
  if (existing.rowCount)
    throw new Error(
      "Local restore target already exists; preserve it and choose a fresh ORBIT_RESTORE_TEST_SUFFIX",
    );
  const user = await auth.user.create({
    data: {
      id: randomUUID(),
      email: randomUUID() + "@example.invalid",
      name: "Synthetic restore acceptance",
    },
  });
  const workspace = await auth.workspace.create({
    data: {
      name: "Synthetic restore acceptance",
      members: { create: { userId: user.id, role: "owner" } },
    },
  });
  const project = await auth.project.create({
    data: {
      workspaceId: workspace.id,
      name: "Synthetic restore fence",
      mode: "observe",
      paused: true,
    },
  });
  const scope = {
    workspaceId: workspace.id,
    projectId: project.id,
    userId: user.id,
  };
  const marker = "SYNTHETIC_RESTORE_" + randomUUID();
  let sourceId = "",
    indexId = "";
  await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      indexId = (await getActiveIndex(tx, scope)).id;
      const record = await tx.entity.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "sources",
          data: {
            name: "Synthetic revoked source",
            status: "active",
            generation: 1,
            publicUse: true,
            modelUse: false,
            authority: "official",
            maxAgeHours: 24,
            allowedOrigins: [],
            allowedPaths: [],
          },
        },
      });
      sourceId = record.id;
      const document = await ingest(tx, scope, {
        sourceId,
        externalId: "restore-fixture",
        title: "Synthetic restore fixture",
        text: marker,
        mimeType: "text/plain",
        language: "en",
        expectedGeneration: 1,
      });
      await revokeDocument(tx, scope, document.documentId);
      await revokeSource(tx, scope, sourceId);
      const content = await tx.entity.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "publications",
          data: {
            status: "outcome_unknown",
            remoteId: "synthetic-remote-reference",
            reason: "restore acceptance requires reconciliation",
          },
        },
      });
      await tx.entity.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          kind: "jobs",
          data: {
            topic: "reconciliation",
            resourceId: content.id,
            status: "queued",
            attempts: 0,
            maxAttempts: 3,
          },
        },
      });
    },
    app,
  );
  const compose = [
    "compose",
    "--env-file",
    ".runtime/local.env",
    "-f",
    "infra/compose.local.yml",
  ];
  const container = execFileSync(
    "docker",
    [...compose, "ps", "-q", "postgres"],
    { encoding: "utf8" },
  ).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container))
    throw new Error("Expected the local Compose postgres container");
  const labels = execFileSync(
    "docker",
    [
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}',
      container,
    ],
    { encoding: "utf8" },
  ).trim();
  if (labels !== "eds-orbit-local postgres")
    throw new Error("Container identity is not the isolated Orbit test stack");
  const started = Date.now();
  const dump = execFileSync(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "--username=orbit_migrator",
      "--dbname=orbit_test",
      "--format=custom",
      "--no-owner",
      "--no-privileges",
    ],
    { maxBuffer: 100_000_000, timeout: 120000 },
  );
  mkdirSync(".runtime/backups", { recursive: true });
  const path = ".runtime/backups/" + targetDatabase + ".dump";
  writeFileSync(path, dump, { mode: 0o600 });
  await admin.query(
    'CREATE DATABASE "' + targetDatabase + '" OWNER orbit_migrator',
  );
  const restore = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "--username=orbit_migrator",
      "--dbname=" + targetDatabase,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
    ],
    { input: dump, encoding: "buffer", timeout: 120000, maxBuffer: 4_000_000 },
  );
  if (restore.status !== 0)
    throw new Error("Local pg_restore failed; target retained for inspection");
  const clone = new Client({ connectionString: target.toString() });
  await clone.connect();
  try {
    await clone.query('UPDATE "Project" SET paused=true,mode=$1', ["observe"]);
  } finally {
    await clone.end();
  }
  const grant = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/db-deploy.ts", "--grants-only"],
    {
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: target.toString(),
        DATABASE_URL: targetApp.toString(),
        AUTH_DATABASE_URL: targetAuth.toString(),
        ENABLE_EXTERNAL_WRITES: "false",
        EXECUTION_MODE: "test",
      },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4_000_000,
    },
  );
  if (grant.status !== 0) throw new Error("Restored role verification failed");
  restored = createClient(targetApp.toString());
  const verified = await scoped(
    scope.workspaceId,
    scope.projectId,
    async (tx) => {
      const restoredIndex = await getActiveIndex(tx, scope);
      if (
        restoredIndex.id !== indexId ||
        restoredIndex.generation !== 1 ||
        restoredIndex.dimensions !== 1536
      )
        throw new Error("Index generation configuration lost");
      const record = await tx.entity.findFirstOrThrow({
        where: { id: sourceId },
      });
      if ((record.data as Record<string, unknown>).status !== "revoked")
        throw new Error("Revocation journal lost");
      if ((await tx.knowledgeDocument.count({ where: { sourceId } })) !== 0)
        throw new Error("Removed document revived");
      if ((await tx.entity.count({ where: { kind: "revocations" } })) < 1)
        throw new Error("Document tombstone lost");
      const e = await retrieve(tx, scope, { query: marker, purpose: "public" });
      if (
        (e.data as Record<string, unknown>).status !== "insufficient_evidence"
      )
        throw new Error("Revoked content retrievable after restore");
      const state = await tx.project.findUniqueOrThrow({
        where: { id: project.id },
      });
      if (state.mode !== "observe" || !state.paused)
        throw new Error("Restored publisher not fenced");
      const uncertain = await tx.entity.count({
        where: {
          kind: "publications",
          data: { path: ["status"], equals: "outcome_unknown" },
        },
      });
      if (uncertain !== 1)
        throw new Error("Uncertain publication journal lost");
      return {
        auditEvents: await tx.auditEvent.count(),
        documentTombstones: await tx.entity.count({
          where: { kind: "revocations" },
        }),
        uncertainPublications: uncertain,
        activeIndexConfigurations: 1,
      };
    },
    restored,
  );
  let denied = false;
  try {
    await scoped(
      scope.workspaceId,
      scope.projectId,
      (tx) =>
        ingest(tx, scope, {
          sourceId,
          externalId: "restore-fixture",
          title: "Fixture",
          text: marker,
          mimeType: "text/plain",
          language: "en",
          expectedGeneration: 1,
        }),
      restored,
    );
  } catch {
    denied = true;
  }
  if (!denied)
    throw new Error("Stale importer revived revoked source after restore");
  const evidence = {
    status: "PASS_TEST",
    executedAt: new Date().toISOString(),
    sourceDatabase: "orbit_test",
    restoredDatabase: targetDatabase,
    dumpBytes: dump.length,
    dumpSha256: createHash("sha256").update(dump).digest("hex"),
    elapsedMs: Date.now() - started,
    externalWrites: false,
    publishersStarted: 0,
    deletedDatabases: 0,
    ...verified,
  };
  writeFileSync(
    "docs/BACKUP_RESTORE_TEST_RESULT.json",
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence));
} catch (e) {
  console.error(
    e instanceof Error && !("code" in e)
      ? e.message
      : "Local restore test failed; raw driver details suppressed",
  );
  process.exitCode = 1;
} finally {
  await admin.end();
  await app.$disconnect();
  await auth.$disconnect();
  await restored?.$disconnect();
}
