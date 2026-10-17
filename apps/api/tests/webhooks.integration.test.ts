import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { buildServer } from "../src/server.ts";
import { create, credentialKey, encrypt, list } from "../src/shared.ts";
import {
  registerModules,
  registerTestModules,
} from "../src/modules/registry.ts";
import { registeredJobs } from "../src/platform/modules/contributions.ts";
import {
  fixtureSignature,
  tasksFixture,
} from "./fixtures/modules/tasks/contributions.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
registerTestModules([tasksFixture]);
registerModules();

const SECRET = "synthetic-fixture-webhook-secret";

/**
 * Public ingress for signed provider webhooks (WP4.2a): the fixture module
 * receives its provider's webhooks through the platform's route. Every
 * rejection path answers without side effects except its audit event.
 */
describe.skipIf(!enabled)("signed provider webhooks", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  let other: Scope;
  let connectionId = "";
  let limitedId = "";
  let foreignId = "";
  const workspaces: string[] = [];
  const run = <T>(fn: (tx: DbTx) => Promise<T>, s = scope) =>
    scoped(s.workspaceId, s.projectId, fn);
  const post = (
    options: {
      provider?: string;
      connection?: string;
      target?: Scope;
      body?: string;
      secret?: string;
      messageId?: string;
      contentType?: string;
    } = {},
  ) => {
    const body = options.body ?? JSON.stringify({ title: "From webhook" });
    const target = options.target ?? scope;
    return app.inject({
      method: "POST",
      url: `/api/hooks/${options.provider ?? "fixture"}/${target.workspaceId}/${target.projectId}/${options.connection ?? connectionId}`,
      headers: {
        "content-type": options.contentType ?? "application/json",
        "x-fixture-signature": fixtureSignature(body, options.secret ?? SECRET),
        ...(options.messageId === ""
          ? {}
          : {
              "x-fixture-message-id": options.messageId ?? randomUUID(),
            }),
      },
      payload: body,
    });
  };
  const count = (kind: string, s = scope) =>
    run((tx) => tx.entity.count({ where: { kind } }), s);

  beforeAll(async () => {
    app = await buildServer();
    const project = async () => {
      const workspace = await authDb.workspace.create({
        data: { name: "Synthetic webhooks" },
      });
      workspaces.push(workspace.id);
      const row = await authDb.project.create({
        data: { workspaceId: workspace.id, name: "Synthetic webhooks" },
      });
      return {
        workspaceId: workspace.id,
        projectId: row.id,
        userId: "setup",
        role: "owner" as const,
      };
    };
    scope = await project();
    other = await project();
    const connection = (s: Scope, provider = "fixture") =>
      run(
        (tx) =>
          create(tx, s, "connectors", {
            provider,
            status: "configured",
            encryptedCredential: encrypt(SECRET, credentialKey()),
          }),
        s,
      ).then((row) => row.id);
    connectionId = await connection(scope);
    limitedId = await connection(scope);
    foreignId = await connection(scope, "postiz");
    await connection(other);
  });
  afterEach(() => {
    delete process.env.ORBIT_PUBLIC_INGRESS;
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await app?.close();
    await closeDatabase();
  });

  it("does not exist while the flag is off", async () => {
    const response = await post();
    expect(response.statusCode).toBe(404);
    expect(await count("inbound_webhooks")).toBe(0);
  });

  it("answers 404 for an unknown provider, connection or a connection of another provider or project", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    expect((await post({ provider: "unknown" })).statusCode).toBe(404);
    expect((await post({ connection: randomUUID() })).statusCode).toBe(404);
    expect((await post({ connection: foreignId })).statusCode).toBe(404);
    // The connection exists, but in the first project, not in this one.
    expect((await post({ target: other })).statusCode).toBe(404);
    expect(await count("inbound_webhooks")).toBe(0);
  });

  it("rejects a forged signature with 401 and audits it", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const response = await post({ secret: "wrong-secret" });
    expect(response.statusCode).toBe(401);
    expect(await count("inbound_webhooks")).toBe(0);
    const audits = await run((tx) =>
      tx.auditEvent.findMany({ where: { action: "webhook.rejected" } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      provider: "fixture",
      reason: "signature",
    });
  });

  it("accepts JSON only, up to 256 KB, with a message id", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    expect((await post({ contentType: "text/plain" })).statusCode).toBe(415);
    const big = JSON.stringify({ title: "x".repeat(300_000) });
    expect((await post({ body: big })).statusCode).toBe(413);
    expect((await post({ messageId: "" })).statusCode).toBe(400);
    expect(await count("inbound_webhooks")).toBe(0);
  });

  it("stores a valid message, enqueues its job once and refuses the replay", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const messageId = randomUUID();
    // No session, cookie or Origin: the signature authenticates.
    const first = await post({ messageId });
    expect(first.statusCode).toBe(200);
    const [stored] = await run((tx) => list(tx, scope, "inbound_webhooks"));
    expect(stored!.data).toMatchObject({
      provider: "fixture",
      connectionId,
      messageId,
      body: { title: "From webhook" },
      status: "queued",
    });
    const jobs = (await run((tx) => list(tx, scope, "jobs"))).filter(
      (row) => (row.data as { topic: string }).topic === "fixture_webhook",
    );
    expect(jobs).toHaveLength(1);

    const replay = await post({ messageId });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe("DUPLICATE_MESSAGE");
    expect(await count("inbound_webhooks")).toBe(1);
    expect(
      await run((tx) =>
        tx.auditEvent.count({ where: { action: "webhook.duplicate" } }),
      ),
    ).toBe(1);

    // The module's job processes the stored message.
    await registeredJobs()
      .get("fixture_webhook")!
      .handler({
        scope: { ...scope, userId: "worker" },
        jobId: jobs[0]!.id,
        job: jobs[0]!.data as Record<string, any>,
        executionMode: "test",
      });
    const tasks = await run((tx) => list(tx, scope, "fixture_tasks"));
    expect(tasks.map((row) => (row.data as { title: string }).title)).toEqual([
      "From webhook",
    ]);
  });

  it("rate-limits each connection on its own", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const codes: number[] = [];
    for (let i = 0; i < 125; i++)
      codes.push(
        (await post({ connection: limitedId, secret: "wrong-secret" }))
          .statusCode,
      );
    expect(codes.slice(0, 120).every((code) => code === 401)).toBe(true);
    expect(codes.slice(120).every((code) => code === 429)).toBe(true);
    // Another connection is not affected.
    expect((await post()).statusCode).toBe(200);
  });

  it("keeps the Origin check for every other write", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${scope.projectId}/actions/retrieve`,
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_REQUIRED");
  });

  it("takes Slack interactions as signed forms, with the same checks (WP4.2)", async () => {
    process.env.ORBIT_PUBLIC_INGRESS = "true";
    const signingSecret = "synthetic-slack-signing-secret";
    const slackId = await run((tx) =>
      create(tx, scope, "connectors", {
        provider: "slack",
        status: "configured",
        confirmChannelMandate: true,
        teamId: "TEAM1",
        channelId: "C1",
        // Mapped to a user who is no owner of this project.
        actors: [{ slackUserId: "USER1", orbitUserId: randomUUID() }],
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
        encryptedCredential: encrypt(
          JSON.stringify({ botToken: "synthetic-bot", signingSecret }),
          credentialKey(),
        ),
      }),
    ).then((row) => row.id);
    const form = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        team: { id: "TEAM1" },
        channel: { id: "C1" },
        user: { id: "USER1" },
        actions: [{ action_id: "orbit_approve", value: randomUUID() }],
      }),
    }).toString();
    const slack = (
      options: {
        connection?: string;
        secret?: string;
        type?: string;
        signed?: boolean;
      } = {},
    ) => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature =
        "v0=" +
        createHmac("sha256", options.secret ?? signingSecret)
          .update(`v0:${timestamp}:${form}`)
          .digest("hex");
      return app.inject({
        method: "POST",
        url: `/api/hooks/slack/${scope.workspaceId}/${scope.projectId}/${options.connection ?? slackId}`,
        headers: {
          "content-type": options.type ?? "application/x-www-form-urlencoded",
          ...(options.signed === false
            ? {}
            : {
                "x-slack-request-timestamp": timestamp,
                "x-slack-signature": signature,
              }),
        },
        payload: form,
      });
    };
    const stored = await count("inbound_webhooks");
    expect((await slack({ type: "application/json" })).statusCode).toBe(415);
    expect((await slack({ signed: false })).statusCode).toBe(401);
    // Only the project's Slack connector.
    expect((await slack({ connection: connectionId })).statusCode).toBe(404);
    const forged = await slack({ secret: "wrong" });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.code).toBe("SLACK_SIGNATURE_INVALID");
    // A valid signature reaches the actor check: USER1 is no owner here.
    const signed = await slack();
    expect(signed.statusCode).toBe(403);
    expect(signed.json().error.code).toBe("SLACK_ACTOR_UNAUTHORIZED");
    // Nothing of it is stored as a queued webhook.
    expect(await count("inbound_webhooks")).toBe(stored);
  });
});
