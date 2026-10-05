import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Offline: the model is replaced by recorded output items; no network call is made.
const replay = vi.hoisted(() => ({
  outputs: [] as unknown[][],
  calls: 0,
  inputs: [] as unknown[][],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  streamChat: vi.fn(async (request: { input: unknown[] }) => {
    const index = replay.calls++;
    replay.inputs.push(structuredClone(request.input));
    const output = replay.outputs[index];
    if (!output) throw new Error("REPLAY_STEP_MISSING");
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "response.completed",
          response: {
            id: `resp_${index}`,
            usage: { input_tokens: 100, output_tokens: 20 },
            output,
          },
        };
      },
    };
  }),
}));
import { randomUUID } from "node:crypto";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  createConversation,
  getRun,
  sendMessage,
} from "../src/modules/chat.ts";
import { runChat } from "../src/modules/chat-runner.ts";
import { createPackageProject, X } from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

describe.skipIf(!enabled)(
  "Package tool errors reach the operator as codes",
  () => {
    let project: Awaited<ReturnType<typeof createPackageProject>>;

    beforeAll(async () => {
      process.env.ORBIT_CONTENT_PACKAGES = "true";
      project = await createPackageProject();
    });
    afterAll(async () => {
      delete process.env.ORBIT_CONTENT_PACKAGES;
      await project.cleanup();
      await closeDatabase();
    });

    it("reports invalid package input with the invalid fields instead of CHAT_FAILED", async () => {
      replay.outputs = [
        [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "c1",
            name: "request_content_package",
            arguments: JSON.stringify({
              goal: "x",
              audience: null,
              channels: [X],
              factKeys: ["beta.access"],
              campaignType: null,
              imageBrief: null,
              intendedDate: null,
            }),
          },
        ],
        [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The goal was too short." }],
          },
        ],
      ];
      replay.calls = 0;
      replay.inputs = [];
      const thread = await createConversation(project.editor);
      const sent = await sendMessage(project.editor, thread.id, {
        text: "x",
        clientRequestId: randomUUID(),
      });
      await runChat(project.editor, sent.runId);
      expect((await getRun(project.editor, sent.runId)).status).toBe(
        "succeeded",
      );
      const output = (replay.inputs[1] as Array<Record<string, any>>).find(
        (item) => item.type === "function_call_output",
      )!;
      expect(JSON.parse(output.output)).toEqual({
        error: "PACKAGE_VALIDATION_FAILED",
        invalidFields: ["goal"],
      });
    });
  },
);
