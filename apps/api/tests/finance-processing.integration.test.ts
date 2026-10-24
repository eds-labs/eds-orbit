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
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { data, list } from "../src/shared.ts";
import { setObjectStoreForTests } from "../src/platform/files/files.ts";
import type { ObjectStore } from "../src/platform/files/s3.ts";
import { runFinanceExtraction } from "../src/modules/finance/extraction/extract.ts";
import {
  listProcessingErrors,
  processingStatus,
} from "../src/modules/finance/extraction/processing.ts";
import { ingestDocument } from "../src/modules/finance/intake/documents.ts";
import {
  retryExtraction,
  updateDraft,
} from "../src/modules/finance/review.ts";
import {
  readFinanceSettings,
  writeFinanceSettings,
} from "../src/modules/finance/settings.ts";
import { applyFinanceTemplate } from "../src/modules/finance/setup.ts";
import { registerModules } from "../src/modules/registry.ts";
import { createPackageProject } from "./support/package-project.ts";

registerModules();

const mocked = vi.hoisted(() => ({
  replies: [] as unknown[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  respond: vi.fn(async (request: any) => {
    const next = mocked.replies.shift();
    if (next === undefined) throw new Error("NO_RECORDED_REPLY");
    return {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: typeof next === "string" ? next : JSON.stringify(next),
            },
          ],
        },
      ],
      usage: {
        model: request.route.model,
        inputTokens: 100,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 20,
        reasoningTokens: 0,
        costMicros: 9,
      },
      responseId: "resp_processing",
    };
  }),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const ENV = {
  ORBIT_FINANCE: "true",
  ORBIT_FILES: "true",
  FILES_S3_ENDPOINT: "https://files.example.invalid",
  FILES_S3_BUCKET: "orbit-files-test",
  FILES_S3_ACCESS_KEY_ID: "synthetic-access-key",
  FILES_S3_SECRET_ACCESS_KEY: "synthetic-secret-key",
  FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const pdf = () =>
  Buffer.concat([
    readFileSync(new URL("./fixtures/finance/invoice.pdf", import.meta.url)),
    Buffer.from(`%${randomUUID()}\n`),
  ]);
const answer = () => ({
  docType: "invoice",
  direction: "payable",
  counterparty: { name: "Hosting GmbH", taxId: null, email: null },
  number: `R-${randomUUID().slice(0, 8)}`,
  issueDate: "2026-10-20",
  dueDate: null,
  currency: "EUR",
  net: "100.00",
  tax: "19.00",
  total: "119.00",
  paid: false,
  paymentMethod: null,
  lines: [
    {
      description: "Server",
      quantity: "1",
      amount: "100.00",
      tax: "19.00",
      categoryHint: null,
      costCenterHint: null,
    },
  ],
  confidence: 0.95,
});

/**
 * A document that arrived while AI extraction was off (the production case
 * of 24 October): it can be extracted later, by the owner turning AI on or
 * by a person, and failures stay visible with a fixed code.
 */
describe.skipIf(!enabled)("finance extraction processing", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  const previous: Record<string, string | undefined> = {};
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    put: async (key, body) => void objects.set(key, body),
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
  };
  const scope = () => project.owner;
  const run = <T>(fn: (tx: DbTx) => Promise<T>) =>
    scoped(scope().workspaceId, scope().projectId, fn);
  const doc = (id: string) =>
    run((tx) => tx.financeDocument.findUniqueOrThrow({ where: { id } }));
  const upload = async () =>
    (
      await ingestDocument(scope(), {
        source: "upload",
        bytes: pdf(),
        mime: "application/pdf",
      })
    ).id;
  const setAi = (value: "on" | "off") =>
    run(async (tx) => {
      const { version } = await readFinanceSettings(tx, scope());
      await writeFinanceSettings(tx, scope(), version, {
        aiExtraction: value,
      });
    });
  const jobKeys = (id: string) =>
    run(async (tx) =>
      (await list(tx, scope(), "jobs"))
        .map((job) => String(data(job).idempotencyKey))
        .filter((key) => key.includes(id)),
    );
  const code = (fn: () => Promise<unknown>) =>
    fn().then(
      () => "ok",
      (error: { code?: string }) => error.code,
    );

  beforeAll(async () => {
    for (const key of Object.keys(ENV)) previous[key] = process.env[key];
    Object.assign(process.env, ENV);
    setObjectStoreForTests(store);
    project = await createPackageProject({ name: "Synthetic finance processing" });
    await run(async (tx) => {
      await tx.projectModule.create({
        data: {
          workspaceId: scope().workspaceId,
          projectId: scope().projectId,
          moduleId: "finance",
          enabled: true,
          moduleVersion: "1.0.0",
          settings: { aiExtraction: "off" },
        },
      });
      await applyFinanceTemplate(tx, scope());
    });
  });
  afterEach(() => {
    mocked.replies.length = 0;
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setObjectStoreForTests(null);
    await project?.cleanup();
    await closeDatabase();
  });

  it("refuses a manual start while AI is off, and queues the waiting documents when it is turned on", async () => {
    const waiting = await upload();
    expect(await doc(waiting)).toMatchObject({
      status: "needs_review",
      flags: ["ai_off"],
    });
    expect(await code(() => run((tx) => retryExtraction(tx, scope(), waiting)))).toBe(
      "FINANCE_AI_OFF",
    );
    const status = await run((tx) =>
      processingStatus(tx, scope(), waiting, false),
    );
    expect(status).toMatchObject({
      canStartExtraction: false,
      blockedBy: "FINANCE_AI_OFF",
      extracted: false,
    });

    await setAi("on");

    const queued = await doc(waiting);
    expect(queued.status).toBe("received");
    expect(queued.flags).not.toContain("ai_off");
    expect(await jobKeys(waiting)).toContain(`finance-extract:${waiting}:1`);

    // The worker's job then extracts it like any new document.
    mocked.replies.push(answer());
    await runFinanceExtraction(scope(), {
      documentId: waiting,
      attemptKey: randomUUID(),
    });
    const extracted = await doc(waiting);
    expect(extracted.status).toBe("needs_review");
    expect(extracted.agentRunId).not.toBeNull();
    expect(extracted.extraction).toMatchObject({
      totalMicros: "119000000",
      extractionAttempt: 1,
    });
    expect((extracted.extraction as Record<string, unknown>).processing).toBeUndefined();
    await setAi("off");
  });

  it("lets a person start the extraction for a document that arrived with AI off", async () => {
    const waiting = await upload();
    await setAi("on");
    // Turning AI on already queued it; a second start is refused while it runs.
    expect(await code(() => run((tx) => retryExtraction(tx, scope(), waiting)))).toBe(
      "FINANCE_EXTRACTION_RUNNING",
    );
    await setAi("off");
    const late = await upload();
    await run(async (tx) => {
      const { version } = await readFinanceSettings(tx, scope());
      // Turn AI on without the backlog, as if the setting was already on.
      await tx.projectModule.updateMany({
        where: { projectId: scope().projectId, moduleId: "finance" },
        data: { settings: { aiExtraction: "on" }, settingsVersion: version + 1 },
      });
    });
    expect(await doc(late)).toMatchObject({ status: "needs_review" });
    await run((tx) => retryExtraction(tx, scope(), late));
    expect(await doc(late)).toMatchObject({ status: "received" });
    expect(await jobKeys(late)).toContain(`finance-extract:${late}:1`);
    await setAi("off");
  });

  it("never overwrites a person's edits, a finished extraction or a too-long document", async () => {
    const edited = await upload();
    await run(async (tx) => {
      const d = await tx.financeDocument.findUniqueOrThrow({ where: { id: edited } });
      await updateDraft(tx, scope(), edited, d.version, { number: "HAND-1" });
    });
    const long = await upload();
    await run((tx) =>
      tx.financeDocument.update({
        where: { id: long },
        data: { flags: ["too_long"] },
      }),
    );
    await run(async (tx) =>
      tx.projectModule.updateMany({
        where: { projectId: scope().projectId, moduleId: "finance" },
        data: { settings: { aiExtraction: "on" } },
      }),
    );
    expect(await code(() => run((tx) => retryExtraction(tx, scope(), edited)))).toBe(
      "FINANCE_DRAFT_EDITED",
    );
    expect(await code(() => run((tx) => retryExtraction(tx, scope(), long)))).toBe(
      "FINANCE_DOCUMENT_TOO_LONG",
    );

    const done = await upload();
    mocked.replies.push(answer());
    await runFinanceExtraction(scope(), { documentId: done, attemptKey: randomUUID() });
    expect(await code(() => run((tx) => retryExtraction(tx, scope(), done)))).toBe(
      "FINANCE_EXTRACTION_DONE",
    );
    await setAi("off");
  });

  it("refuses to start without an active policy and queues nothing then", async () => {
    const setPolicyActive = (active: boolean) =>
      run(async (tx) => {
        const rows = await tx.entity.findMany({
          where: { projectId: scope().projectId, kind: "policies" },
        });
        for (const row of rows)
          await tx.entity.update({
            where: { id: row.id },
            data: { data: { ...(row.data as object), active } },
          });
        return rows.length;
      });
    expect(await setPolicyActive(false)).toBeGreaterThan(0);
    try {
      const waiting = await upload();
      await setAi("on");
      // Turning AI on without a mandate queues nothing.
      expect(await doc(waiting)).toMatchObject({ status: "needs_review" });
      expect(await code(() => run((tx) => retryExtraction(tx, scope(), waiting)))).toBe(
        "POLICY_REQUIRED",
      );
      expect(
        await run((tx) => processingStatus(tx, scope(), waiting, true)),
      ).toMatchObject({ blockedBy: "POLICY_REQUIRED", canStartExtraction: false });
    } finally {
      await setPolicyActive(true);
      await setAi("off");
    }
  });

  it("records why an extraction stopped and lists it as a processing error", async () => {
    await run(async (tx) =>
      tx.projectModule.updateMany({
        where: { projectId: scope().projectId, moduleId: "finance" },
        data: { settings: { aiExtraction: "on" } },
      }),
    );
    const broken = await upload();
    mocked.replies.push("not json at all");
    await runFinanceExtraction(scope(), { documentId: broken, attemptKey: randomUUID() });
    const row = await doc(broken);
    expect(row.status).toBe("needs_review");
    expect(row.flags).toContain("extraction_failed");
    const processing = (row.extraction as { processing?: Record<string, unknown> })
      .processing;
    expect(processing?.lastErrorCode).toEqual(expect.any(String));
    expect(processing?.lastErrorAt).toEqual(expect.any(String));

    const errors = await run((tx) => listProcessingErrors(tx, scope()));
    expect(errors.find((e) => e.documentId === broken)).toMatchObject({
      flags: expect.arrayContaining(["extraction_failed"]),
      lastError: expect.objectContaining({ lastErrorCode: processing?.lastErrorCode }),
    });

    // A person retries; a good answer clears the recorded failure.
    await run((tx) => retryExtraction(tx, scope(), broken));
    mocked.replies.push(answer());
    await runFinanceExtraction(scope(), { documentId: broken, attemptKey: randomUUID() });
    const fixed = await doc(broken);
    expect(fixed.flags).not.toContain("extraction_failed");
    expect((fixed.extraction as Record<string, unknown>).processing).toBeUndefined();
    const status = await run((tx) => processingStatus(tx, scope(), broken, true));
    expect(status).toMatchObject({ extracted: true, attempt: 1 });
    await setAi("off");
  });
});
