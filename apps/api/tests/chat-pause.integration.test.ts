import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, entity, update } from "../src/shared.ts";
import {
  createConversation,
  getConversation,
  getRun,
  sendMessage,
  stopChatRunForPause,
} from "../src/modules/chat.ts";
import { pauseProject } from "../src/modules/pause.ts";
import { createPackageProject } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Production uLiquid, 2026-10-06: while the project was paused the worker
 * blocked the chat job, but the chat run stayed queued, the reply showed
 * "Orbit arbeitet…" forever and the conversation took no new message.
 */
describe.skipIf(!enabled)("Chat while the project is paused", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const pause = (paused: boolean) =>
    run((tx) => pauseProject(tx, project.owner, paused));
  const send = async (conversationId: string) =>
    sendMessage(project.owner, conversationId, {
      text: "Wie ist der Projektstand?",
      clientRequestId: randomUUID(),
    });

  beforeAll(async () => {
    project = await createPackageProject();
  });
  afterAll(async () => {
    await project.cleanup();
    await closeDatabase();
  });

  it("refuses a new message with PROJECT_PAUSED and stores nothing", async () => {
    const thread = await createConversation(project.owner);
    await pause(true);
    await expect(send(thread.id)).rejects.toThrow("PROJECT_PAUSED");
    expect(
      (await getConversation(project.owner, thread.id)).messages,
    ).toHaveLength(0);
    await pause(false);
  });

  it("ends a waiting reply when the project is paused", async () => {
    const thread = await createConversation(project.owner);
    const sent = await send(thread.id);
    await pause(true);
    expect(await getRun(project.owner, sent.runId)).toMatchObject({
      status: "blocked",
      errorCode: "PROJECT_PAUSED",
    });
    await pause(false);
    // The conversation takes the next message again.
    await expect(send(thread.id)).resolves.toMatchObject({ status: "queued" });
  });

  it("ends the reply whose job the worker blocked for the pause", async () => {
    const thread = await createConversation(project.owner);
    const sent = await send(thread.id);
    await run(async (tx) =>
      stopChatRunForPause(
        tx,
        data(await entity(tx, project.owner, "jobs", sent.jobId!)),
      ),
    );
    expect(await getRun(project.owner, sent.runId)).toMatchObject({
      status: "blocked",
      errorCode: "PROJECT_PAUSED",
    });
  });

  it("releases a reply left waiting on a blocked job when the project resumes", async () => {
    const thread = await createConversation(project.owner);
    const sent = await send(thread.id);
    // As in production: the worker blocked the job, the run stayed queued.
    await run(async (tx) => {
      const job = await entity(tx, project.owner, "jobs", sent.jobId!);
      await update(tx, project.owner, job, {
        ...data(job),
        status: "blocked_dependency",
        error: "PROJECT_PAUSED",
      });
    });
    await pause(false);
    expect(await getRun(project.owner, sent.runId)).toMatchObject({
      status: "blocked",
      errorCode: "PROJECT_PAUSED",
    });
  });
});
