import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Every model call is a recorded reply; nothing here reaches a provider.
type Reply = { output: unknown[]; costMicros?: number };
const provider = vi.hoisted(() => ({
  generate: vi.fn(),
  embed: vi.fn(),
  requests: [] as any[],
  replies: [] as Array<(request: any) => Reply>,
  // Live preconditions outside this task: an evaluated live index and a Postiz client.
  liveIndex: false,
  createPost: vi.fn(),
}));
vi.mock("../../../packages/knowledge/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/knowledge/src/index.ts")
    >();
  return {
    ...actual,
    validateActiveIndexEvaluation: async (
      ...args: Parameters<typeof actual.validateActiveIndexEvaluation>
    ) =>
      provider.liveIndex
        ? { valid: true, reasons: [] }
        : actual.validateActiveIndexEvaluation(...args),
  };
});
vi.mock("../../../packages/connectors/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../packages/connectors/src/index.ts")
    >();
  return {
    ...actual,
    createPostizClient: (...args: any[]) =>
      provider.liveIndex
        ? { createPost: provider.createPost, uploadMedia: vi.fn() }
        : (actual.createPostizClient as any)(...args),
  };
});
vi.mock("../../../packages/ai/src/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../packages/ai/src/index.ts")>();
  return {
    ...actual,
    generate: provider.generate,
    embed: provider.embed,
    respond: vi.fn(async (request: any) => {
      provider.requests.push(structuredClone(request));
      const next = provider.replies.shift();
      if (!next) throw new Error("NO_RECORDED_REPLY");
      const reply = next(request);
      return {
        output: reply.output,
        usage: {
          model: request.route.model,
          inputTokens: 100,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
          costMicros: reply.costMicros ?? 7,
        },
        responseId: `resp_${provider.requests.length}`,
      };
    }),
  };
});
import { closeDatabase } from "../../../packages/db/src/index.ts";
import { ConnectorError } from "../../../packages/connectors/src/index.ts";
import { loadConfig } from "../../../packages/config/src/index.ts";
import { create, data, encrypt, entity, list, update } from "../src/shared.ts";
import { sweepProject, nextSweepAt } from "../src/modules/lifecycle.ts";
import {
  planAssignmentRuns,
  startReadySteps,
} from "../src/modules/agents/assignment-runs.ts";
import {
  assignmentHash,
  updateAssignment,
} from "../src/modules/agents/assignments.ts";
import { runAgentTask } from "../src/modules/agents/specialists/runner.ts";
import { registerAgentSpecialists } from "../src/modules/agents/specialists/index.ts";
import { pauseProject } from "../src/modules/pause.ts";
import { dispatchPublication } from "../src/modules/publisher.ts";
import { claimPublication } from "../src/modules/workflow.ts";
import { stopCallbackData } from "../src/modules/telegram.ts";
import {
  nextDailyReportAt,
  notify,
  planDailyReport,
} from "../src/modules/agents/notifications.ts";
import { sendNotification } from "../src/modules/agents/notification-sender.ts";
import { createPackageProject, X } from "./support/package-project.ts";
import {
  assignmentRun,
  BLOG,
  embedded,
  generated,
  message,
  tomorrowMorning,
} from "./support/assignment-review.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Synthetic token in Telegram's shape; the fake transport below is the only "Telegram".
const TOKEN = "123456789:AAsyntheticTelegramTokenForTests_0123456";
const CHAT = "4711";
const BODY = "Beta access is open for product teams. Learn more.";
const MINUTE = 60000;
// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type TelegramCall = { method: string; body: Record<string, any> };
type Verdict = { verdict: "approve" | "reject"; reasons?: string[] };

const shown = (request: any): Array<Record<string, any>> =>
  JSON.parse(request.input[0].content).drafts;
/** A recorded review answer: one verdict per shown draft. */
const answer =
  (decide: (draft: Record<string, any>) => Verdict) =>
  (request: any): Reply => ({
    output: [
      message({
        decisions: shown(request).map((draft) => ({
          contentId: draft.contentId,
          reasons: [],
          revisionInstructions: null,
          ...decide(draft),
        })),
      }),
    ],
  });

describe.skipIf(!enabled)("Orbit Agents Telegram notifications", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let h: ReturnType<typeof assignmentRun>;
  const calls: TelegramCall[] = [];
  // Set to make the fake Telegram answer with an error instead of ok.
  let failWith: null | (() => Response | Promise<Response>) = null;
  const sleeps: number[] = [];

  /** Stands in for api.telegram.org: records every call and answers ok. */
  const fetch = async (url: string | URL, init: RequestInit = {}) => {
    const method = String(url).split("/").pop()!;
    const body =
      init.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, body });
    if (failWith) return failWith();
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: calls.length } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const send = (jobId: string) =>
    sendNotification(h.worker(), jobId, { fetch, sleep });
  const sent = () => calls.filter((c) => c.method.startsWith("send"));
  const markup = (call: TelegramCall) =>
    (typeof call.body.reply_markup === "string"
      ? JSON.parse(call.body.reply_markup)
      : call.body.reply_markup
    ).inline_keyboard[0] as Array<Record<string, string>>;
  const textOf = (call: TelegramCall) =>
    String(call.body.text ?? call.body.caption ?? "");

  /** A bot bound to a current owner of the project. */
  const linkBot = (userId = project.owner.userId) =>
    h.run((tx) =>
      create(tx, project.owner, "telegram_connections", {
        status: "linked",
        encryptedToken: encrypt(TOKEN, process.env.CREDENTIAL_KEY!),
        chatId: CHAT,
        telegramUserId: CHAT,
        linkedUserId: userId,
        linkedAt: new Date().toISOString(),
      }),
    );
  const jobOf = async (kind: string, ref: string) =>
    (await h.rows("jobs")).find(
      (job) => job.idempotencyKey === `notify:${kind}:${ref}`,
    );
  const jobsOf = async (kind: string) =>
    (await h.rows("jobs")).filter((job) =>
      String(job.idempotencyKey ?? "").startsWith(`notify:${kind}:`),
    );
  const exceptions = async () =>
    (await h.rows("exceptions")).filter((row) => row.status === "open");
  /** A post with a veto window, its draft and a PNG attached, as the schedule step leaves them. */
  const post = (
    changes: Record<string, unknown> = {},
    withImage = true,
    body = BODY,
  ) =>
    h.run(async (tx) => {
      const asset = withImage
        ? await create(tx, project.owner, "assets", {
            name: "Synthetic banner",
            type: "generated_artwork",
            mime: "image/png",
            base64: PNG.toString("base64"),
            sha256: (await import("node:crypto"))
              .createHash("sha256")
              .update(PNG)
              .digest("hex"),
            usageApproved: true,
            assetStatus: "approved",
          })
        : null;
      const content = await create(tx, project.owner, "content", {
        type: "social",
        channel: X,
        body,
        status: "reviewed",
        assetId: asset?.id ?? null,
      });
      const pub = await create(tx, project.owner, "publications", {
        status: "intent_created",
        contentId: content.id,
        channel: X,
        scheduledAt: new Date(Date.now() + 4 * 60 * MINUTE).toISOString(),
        vetoDeadline: new Date(Date.now() + 60 * MINUTE).toISOString(),
        vetoedAt: null,
        test: true,
        ...changes,
      });
      return pub;
    });
  const queue = (kind: Parameters<typeof notify>[2], ref: string) =>
    h.run((tx) => notify(tx, project.owner, kind, ref));

  const reviewedRun = async (
    decide: (draft: Record<string, any>) => Verdict = () => ({
      verdict: "approve",
    }),
  ) => {
    const planned = await h.planWithBriefs((slots) =>
      slots.map((slot) => h.brief(slot)),
    );
    for (const copy of (await h.rows("agent_tasks")).filter(
      (t) => t.role === "copywriter",
    ))
      await runAgentTask(h.worker(), copy.id);
    const review = await h.task("review");
    return { ...planned, review, run: () => reviewTask(review.id, decide) };
  };
  const reviewTask = async (
    taskId: string,
    decide: (draft: Record<string, any>) => Verdict,
  ) => {
    provider.replies.push(answer(decide));
    await runAgentTask(h.worker(), taskId);
    expect((await h.task("review")).status).toBe("done");
  };

  beforeEach(async () => {
    process.env.ORBIT_AGENTS = "true";
    process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "true";
    calls.length = 0;
    sleeps.length = 0;
    failWith = null;
    provider.requests = [];
    provider.replies = [];
    provider.liveIndex = false;
    provider.createPost.mockReset();
    provider.embed.mockReset().mockResolvedValue(embedded());
    provider.generate.mockReset().mockImplementation(async (params: any) => {
      const contract = JSON.parse(params.goal);
      return generated(`${BODY} (${String(contract.brief?.topic ?? "")})`);
    });
    project = await createPackageProject();
    h = assignmentRun(project);
    await h.setPolicy({
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2027-12-31T00:00:00.000Z",
      channels: [X],
      contentTypes: ["social", "blog"],
      maxPerDay: 2,
      minIntervalMinutes: 120,
    });
    registerAgentSpecialists();
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.ORBIT_AGENTS;
    delete process.env.ORBIT_AGENT_REVIEW_AUTHORITY;
    await project.cleanup();
  });
  afterAll(() => closeDatabase());

  it("sends one preview per publication with image and Stop", async () => {
    await linkBot();
    const a = await post();
    const b = await post();
    // Queuing twice is one job (the scheduler's own key format).
    await queue("preview", a.id);
    await queue("preview", a.id);
    await queue("preview", b.id);
    expect(await jobsOf("preview")).toHaveLength(2);

    const first = (await jobOf("preview", a.id))!;
    const second = (await jobOf("preview", b.id))!;
    expect(first).toMatchObject({
      topic: "telegram_notification",
      resourceId: a.id,
    });
    await send(first.id);
    await send(second.id);
    // Sending the same job again sends nothing.
    await send(first.id);

    expect(sent().map((c) => c.method)).toEqual(["sendPhoto", "sendPhoto"]);
    const [photo] = sent();
    expect(photo!.body.chat_id).toBe(CHAT);
    // The photo is the content's PNG, not a placeholder.
    expect(
      Buffer.from(await (photo!.body.photo as Blob).arrayBuffer()),
    ).toEqual(PNG);
    const caption = textOf(photo!);
    expect(caption).toContain("Synthetic X");
    expect(caption).toContain(BODY);
    // The slot is shown in the project's time zone (Berlin).
    expect(caption).toContain("Europe/Berlin");
    const buttons = markup(photo!);
    expect(buttons[0]).toEqual({
      text: "Stop",
      callback_data: stopCallbackData(a.id, a.version),
    });
    expect(buttons[1]).toEqual({
      text: "In Orbit öffnen",
      url: `${loadConfig().APP_ORIGIN.replace(/\/+$/, "")}/approvals`,
    });
    expect(markup(sent()[1]!)[0]!.callback_data).toBe(
      stopCallbackData(b.id, b.version),
    );
    expect((await jobOf("preview", a.id))!.notification).toMatchObject({
      outcome: "sent",
    });
  });

  it("sends the text alone when the image cannot be read, and a long text in two messages", async () => {
    await linkBot();
    const plain = await post({}, false);
    const broken = await post();
    const long = await post({}, true, "A".repeat(1500));
    // The image is damaged: the checksum no longer matches.
    await h.run(async (tx) => {
      const content = await entity(
        tx,
        project.owner,
        "content",
        data(broken).contentId,
      );
      const asset = await entity(
        tx,
        project.owner,
        "assets",
        data(content).assetId,
      );
      await update(tx, project.owner, asset, {
        ...data(asset),
        sha256: "0".repeat(64),
      });
    });
    for (const pub of [plain, broken, long]) await queue("preview", pub.id);
    for (const pub of [plain, broken, long])
      await send((await jobOf("preview", pub.id))!.id);
    expect(sent().map((c) => c.method)).toEqual([
      "sendMessage",
      "sendMessage",
      // A caption holds 1024 characters: the photo first, then the full text with the buttons.
      "sendPhoto",
      "sendMessage",
    ]);
    expect(textOf(sent()[1]!)).toContain(BODY);
    expect(markup(sent()[1]!)[0]!.callback_data).toBe(
      stopCallbackData(broken.id, broken.version),
    );
    expect(sent()[2]!.body.reply_markup).toBeUndefined();
    expect(textOf(sent()[3]!)).toContain("A".repeat(1500));
    expect(markup(sent()[3]!)[0]!.callback_data).toBe(
      stopCallbackData(long.id, long.version),
    );
  });

  it("skips a stale preview without an error", async () => {
    await linkBot();
    const stopped = await post({
      status: "canceled",
      vetoedAt: "2026-10-09T08:00:00.000Z",
    });
    const late = await post({
      vetoDeadline: new Date(Date.now() - MINUTE).toISOString(),
    });
    const handed = await post({ status: "scheduled_remote" });
    for (const pub of [stopped, late, handed]) {
      await queue("preview", pub.id);
      await send((await jobOf("preview", pub.id))!.id);
      expect((await jobOf("preview", pub.id))!.notification).toEqual({
        outcome: "skipped",
        reason: "STALE",
        at: expect.any(String),
      });
    }
    expect(calls).toHaveLength(0);
    expect(await exceptions()).toEqual([]);
  });

  it("sends nothing without a bound owner and retries nothing", async () => {
    const pub = await post();
    // No bot at all: nothing is even queued.
    await queue("preview", pub.id);
    expect(await jobsOf("preview")).toEqual([]);

    // A bot bound to someone who is only a viewer now: queued, never sent.
    await linkBot(project.viewer.userId);
    await queue("preview", pub.id);
    const job = (await jobOf("preview", pub.id))!;
    await send(job.id);
    expect(calls).toHaveLength(0);
    expect((await jobOf("preview", pub.id))!.notification).toMatchObject({
      outcome: "skipped",
      reason: "NO_BOT",
    });
    expect(sleeps).toEqual([]);
    expect(await exceptions()).toEqual([]);
  });

  it("does nothing while Orbit Agents is off", async () => {
    await linkBot();
    const pub = await post();
    delete process.env.ORBIT_AGENTS;
    expect(await queue("preview", pub.id)).toBeNull();
    expect(await jobsOf("preview")).toEqual([]);
    await h.run((tx) => pauseProject(tx, project.owner, true));
    expect(await jobsOf("project_paused")).toEqual([]);
    expect(
      await h.run((tx) => planDailyReport(tx, project.owner, new Date())),
    ).toBeNull();
  });

  it("retries a failed delivery and records TELEGRAM_DELIVERY_FAILED", async () => {
    await linkBot();
    const pub = await post();
    await queue("preview", pub.id);
    const job = (await jobOf("preview", pub.id))!;
    failWith = () =>
      new Response("{}", {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    await send(job.id);

    // One try and three retries, with growing waits.
    expect(sent()).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
    expect(sleeps[2]!).toBeGreaterThan(sleeps[1]!);
    expect((await jobOf("preview", pub.id))!.notification).toMatchObject({
      outcome: "failed",
    });
    const open = await exceptions();
    expect(open).toEqual([
      expect.objectContaining({
        code: "TELEGRAM_DELIVERY_FAILED",
        resourceIds: [`preview:${pub.id}`],
      }),
    ]);
    // No token and no chat id anywhere in the record.
    const audits = await h.run((tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: project.owner.projectId,
          action: "telegram.delivery_failed",
        },
      }),
    );
    expect(audits).toHaveLength(1);
    const recorded = JSON.stringify([open, audits, await h.rows("jobs")]);
    expect(recorded).not.toContain(TOKEN);
    expect(recorded).not.toContain(CHAT);
    // Publishing rights are untouched.
    const after = await h.run((tx) =>
      entity(tx, project.owner, "publications", pub.id),
    );
    expect(after.version).toBe(pub.version);
    expect(data(after)).toMatchObject({
      status: "intent_created",
      vetoDeadline: data(pub).vetoDeadline,
      vetoedAt: null,
    });
    // Sending the failed job again does not try again.
    calls.length = 0;
    await send(job.id);
    expect(calls).toHaveLength(0);
  });

  it("delivers after a network error without an exception", async () => {
    await linkBot();
    const pub = await post({}, false);
    await queue("preview", pub.id);
    let tries = 0;
    failWith = () => {
      if (++tries < 3) throw new TypeError("fetch failed");
      failWith = null;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 9 } }),
        { status: 200 },
      );
    };
    await send((await jobOf("preview", pub.id))!.id);
    expect(sent()).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect((await jobOf("preview", pub.id))!.notification).toMatchObject({
      outcome: "sent",
    });
    expect(await exceptions()).toEqual([]);
  });

  it("does not retry a refusal that will not change", async () => {
    await linkBot();
    const pub = await post({}, false);
    await queue("preview", pub.id);
    failWith = () => new Response("{}", { status: 403 });
    await send((await jobOf("preview", pub.id))!.id);
    expect(sent()).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect((await exceptions())[0]).toMatchObject({
      code: "TELEGRAM_DELIVERY_FAILED",
    });
  });

  it("does not retry an unclear response, which a retry could duplicate", async () => {
    await linkBot();
    const pub = await post({}, false);
    await queue("preview", pub.id);
    // HTTP 200 with a body that is not Telegram's answer: the message may be out already.
    failWith = () => new Response("not json", { status: 200 });
    await send((await jobOf("preview", pub.id))!.id);
    expect(sent()).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect((await exceptions())[0]).toMatchObject({
      code: "TELEGRAM_DELIVERY_FAILED",
    });
  });

  it("waits for Telegram's retry_after on a rate limit, at most 30 seconds", async () => {
    await linkBot();
    const limited = (retryAfter?: number) => {
      let first = true;
      failWith = () => {
        if (!first) {
          failWith = null;
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 3 } }),
            { status: 200 },
          );
        }
        first = false;
        return new Response(
          JSON.stringify({
            ok: false,
            ...(retryAfter === undefined
              ? {}
              : { parameters: { retry_after: retryAfter } }),
          }),
          { status: 429 },
        );
      };
    };
    for (const [retryAfter, wanted] of [
      [5, 5000],
      [120, 30000],
      [undefined, 1000],
    ] as const) {
      sleeps.length = 0;
      const pub = await post({}, false);
      await queue("preview", pub.id);
      limited(retryAfter);
      await send((await jobOf("preview", pub.id))!.id);
      expect(sleeps).toEqual([wanted]);
      expect((await jobOf("preview", pub.id))!.notification).toMatchObject({
        outcome: "sent",
      });
    }
  });

  it("falls back to the text when Telegram refuses the photo", async () => {
    await linkBot();
    const short = await post();
    const long = await post({}, true, "B".repeat(1500));
    const transientFail = await post();
    for (const pub of [short, long, transientFail])
      await queue("preview", pub.id);
    const photoRefused = (status: number) => {
      const original = fetch;
      return async (url: string | URL, init: RequestInit = {}) =>
        String(url).endsWith("/sendPhoto")
          ? (calls.push({ method: "sendPhoto", body: {} }),
            new Response(JSON.stringify({ ok: false }), { status }))
          : original(url, init);
    };
    const sendWith = (id: string, transport: typeof fetch) =>
      sendNotification(h.worker(), id, { fetch: transport, sleep });

    await sendWith((await jobOf("preview", short.id))!.id, photoRefused(400));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    // The same text and the same buttons as the photo would have had.
    expect(textOf(calls[1]!)).toContain(BODY);
    expect(markup(calls[1]!)[0]!.callback_data).toBe(
      stopCallbackData(short.id, short.version),
    );
    expect((await jobOf("preview", short.id))!.notification).toMatchObject({
      outcome: "sent",
    });

    // A long text: the photo (header only) is dropped, the full text still goes out once.
    calls.length = 0;
    await sendWith((await jobOf("preview", long.id))!.id, photoRefused(400));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(textOf(calls[1]!)).toContain("B".repeat(1500));
    expect(markup(calls[1]!)[0]!.callback_data).toBe(
      stopCallbackData(long.id, long.version),
    );

    // A temporary failure is retried and, when it persists, the notification fails: no fallback.
    calls.length = 0;
    await sendWith(
      (await jobOf("preview", transientFail.id))!.id,
      photoRefused(500),
    );
    expect(calls.map((c) => c.method)).toEqual([
      "sendPhoto",
      "sendPhoto",
      "sendPhoto",
      "sendPhoto",
    ]);
    expect((await exceptions())[0]).toMatchObject({
      code: "TELEGRAM_DELIVERY_FAILED",
    });
  });

  it("shows the weekday and date of the deadline when it is not the day of sending", async () => {
    await linkBot();
    // 2026-10-09 12:00 in Berlin.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00.000Z"));
    const sameDay = await post({
      vetoDeadline: "2026-10-09T15:00:00.000Z",
      scheduledAt: "2026-10-09T18:00:00.000Z",
    });
    const nextDay = await post({
      vetoDeadline: "2026-10-10T07:30:00.000Z",
      scheduledAt: "2026-10-10T10:30:00.000Z",
    });
    for (const pub of [sameDay, nextDay]) {
      await queue("preview", pub.id);
      await send((await jobOf("preview", pub.id))!.id);
    }
    const [a, b] = sent().map(textOf);
    expect(a).toContain("Stop möglich bis 17:00\n");
    expect(b).toContain("Stop möglich bis Sa., 10.10., 09:30\n");
  });

  it("skips a Postiz error notice when the post is no longer failed", async () => {
    await linkBot();
    const failed = await post({ status: "failed" }, false);
    const unclear = await post({ status: "outcome_unknown" }, false);
    const published = await post({ status: "published" }, false);
    for (const pub of [failed, unclear, published])
      await queue("postiz_error", pub.id);
    for (const pub of [failed, unclear, published])
      await send((await jobOf("postiz_error", pub.id))!.id);
    expect(sent().map(textOf)).toEqual([
      expect.stringContaining("nicht veröffentlicht"),
      expect.stringContaining("Ergebnis unklar"),
    ]);
    expect(
      (await jobOf("postiz_error", published.id))!.notification,
    ).toMatchObject({ outcome: "skipped", reason: "STALE" });
  });

  it("reports rejection, budget pause and project pause", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ name: "Zwei Posts am Tag" });
    const planned = await reviewedRun();
    const drafts = (await h.rows("content")).sort((a, b) =>
      String(a.briefKey).localeCompare(String(b.briefKey)),
    );
    // Rejection: the review rejects the first draft.
    await reviewTask(planned.review.id, (draft) =>
      draft.contentId === drafts[0]!.id
        ? { verdict: "reject", reasons: ["Zu werblich."] }
        : { verdict: "approve" },
    );
    const rejected = await jobsOf("rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.idempotencyKey).toContain(drafts[0]!.id);
    // The approved draft got its preview job (Task 11) and no notice.
    expect(await jobsOf("needs_owner")).toEqual([]);
    expect(await jobsOf("preview")).toHaveLength(1);

    // Budget: tomorrow's run is planned, then the month's budget is spent and the assignment pauses itself.
    await h.run((tx) =>
      planAssignmentRuns(
        tx,
        project.owner,
        new Date(tomorrowMorning().valueOf() + 24 * 60 * MINUTE),
      ),
    );
    // The owner lowered the budget and confirmed it.
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", assignment.id);
      const next = { ...data(row), monthlyBudgetMicros: 1 };
      await update(tx, project.owner, row, {
        ...next,
        confirmation: {
          ...data(row).confirmation,
          assignmentHash: assignmentHash(next),
        },
      });
    });
    const nextRun = (await h.rows("assignment_runs")).find(
      (row) => row.id !== planned.runId,
    )!;
    const research = (await h.rows("agent_tasks")).find(
      (t) => t.runId === nextRun.id && t.stepKey === "research",
    )!;
    await runAgentTask(h.worker(), research.id);
    expect(
      data(
        await h.run((tx) =>
          entity(tx, project.owner, "assignments", assignment.id),
        ),
      ).status,
    ).toBe("budget_exhausted");
    const budget = await jobsOf("budget_paused");
    expect(budget).toHaveLength(1);

    // Project pause.
    await h.run((tx) => pauseProject(tx, project.owner, true));
    const pause = await jobsOf("project_paused");
    expect(pause).toHaveLength(1);

    for (const job of [rejected[0]!, budget[0]!, pause[0]!]) await send(job.id);
    const texts = sent().map(textOf);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("abgelehnt");
    expect(texts[0]).toContain("Zu werblich.");
    expect(texts[1]).toContain("Zwei Posts am Tag");
    expect(texts[1]).toContain("Budget");
    // The approved post of the first run was scheduled and is withdrawn with the pause (M6).
    expect(texts[1]).toContain("1 geplanter Beitrag zurückgezogen");
    expect(texts[2]).toContain("pausiert");
  });

  it("reports posts withdrawn because the owner moved the times (R70)", async () => {
    await linkBot();
    const assignment = await h.makeAssignment({ name: "Zwei Posts am Tag" });
    const planned = await reviewedRun();
    await planned.run();
    expect(await jobsOf("preview")).toHaveLength(2);
    await h.run(async (tx) => {
      const row = await entity(tx, project.owner, "assignments", assignment.id);
      await updateAssignment(tx, project.owner, row.id, row.version, {
        schedule: { ...data(row).schedule, times: ["11:00", "18:00"] },
      });
    });
    const [notice] = await jobsOf("retimed");
    expect(notice).toBeTruthy();
    await send(notice!.id);
    const [text] = sent().map(textOf);
    expect(text).toContain("Zeiten geändert");
    expect(text).toContain("Zwei Posts am Tag");
    expect(text).toContain("2 geplante Beiträge zurückgezogen");
    expect(text).toContain("11:00, 18:00");
  });

  it("reports the project pause even though the project is paused", async () => {
    await linkBot();
    await h.run((tx) => pauseProject(tx, project.owner, true));
    const [job] = await jobsOf("project_paused");
    expect(job).toBeTruthy();
    await send(job!.id);
    expect(sent().map((c) => c.method)).toEqual(["sendMessage"]);
    expect(textOf(sent()[0]!)).toContain("pausiert");
    // Pausing again after a resume is a new event with a new notice.
    await h.run((tx) => pauseProject(tx, project.owner, false));
    await h.run((tx) => pauseProject(tx, project.owner, true));
    expect(await jobsOf("project_paused")).toHaveLength(2);
    // A pause through the bot is confirmed there already: no second message.
    await h.run((tx) => pauseProject(tx, project.owner, false));
    await h.run((tx) =>
      pauseProject(tx, project.owner, true, { notify: false }),
    );
    expect(await jobsOf("project_paused")).toHaveLength(2);
  });

  it("sends one daily report with today's numbers", async () => {
    await linkBot();
    const owner = project.owner;
    const now = Date.now();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
    }).format(new Date(now));
    const iso = (ms: number) => new Date(now + ms).toISOString();
    const day = 24 * 60 * MINUTE;
    await h.run(async (tx) => {
      const pubs = (extra: Record<string, unknown>[]): Promise<unknown[]> =>
        Promise.all(
          extra.map((e) =>
            create(tx, owner, "publications", {
              contentId: "synthetic",
              channel: X,
              ...e,
            }),
          ),
        );
      await pubs([
        { status: "published", completedAt: iso(-MINUTE) },
        { status: "published", completedAt: iso(-2 * MINUTE) },
        { status: "scheduled_remote", handoffCompletedAt: iso(-3 * MINUTE) },
        // Yesterday does not count, nor does a post still waiting.
        { status: "published", completedAt: iso(-2 * day) },
        { status: "intent_created", scheduledAt: iso(day) },
        { status: "canceled", vetoedAt: iso(-MINUTE), vetoDeadline: iso(day) },
        {
          status: "canceled",
          vetoedAt: iso(-3 * day),
          vetoDeadline: iso(-2 * day),
        },
      ]);
      // Two rejections the owner was told about, and one draft replaced by its revision.
      for (const [i, metadata] of [
        { revisedTo: null },
        {},
        { revisedTo: "synthetic-revision" },
      ].entries())
        await tx.auditEvent.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            actorId: "worker",
            action: "content.agent_rejected",
            resourceId: `synthetic-${i}`,
            metadata,
          },
        });
      // Stopped deliverables (I4): planning drops, run problems, scheduling drops, blocked posts.
      for (const [action, metadata, at] of [
        ["assignment.run_planned", { unavailable: 1 }, now],
        ["assignment.run_planned", { unavailable: 0 }, now],
        // A day without a run because none of its slots was free (R75).
        ["assignment.day_skipped", { unavailable: 2 }, now],
        [
          "assignment.run_problems",
          { failedSteps: 2, droppedDeliverables: 1 },
          now,
        ],
        ["assignment.deliverable_dropped", {}, now],
        ["publication.claim_blocked", { blockers: ["MISSION_EXPIRED"] }, now],
        // Two days ago: not today's.
        [
          "assignment.run_problems",
          { failedSteps: 5, droppedDeliverables: 5 },
          now - 2 * day,
        ],
        ["publication.claim_blocked", {}, now - 2 * day],
      ] as const)
        await tx.auditEvent.create({
          data: {
            workspaceId: owner.workspaceId,
            projectId: owner.projectId,
            actorId: "worker",
            action,
            resourceId: "synthetic",
            metadata,
            createdAt: new Date(at),
          },
        });
      // Cost: 1.50 settled today, 0.25 on an earlier day of this month if there is one.
      await tx.budgetReservation.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          key: `synthetic-today-${now}`,
          amountMicros: 2_000_000n,
          settledMicros: 1_500_000n,
          category: "agent",
          state: "settled",
          createdAt: new Date(now - MINUTE),
        },
      });
      const earlier = new Date(now - 36 * 60 * MINUTE);
      await tx.budgetReservation.create({
        data: {
          workspaceId: owner.workspaceId,
          projectId: owner.projectId,
          key: `synthetic-earlier-${now}`,
          amountMicros: 300_000n,
          settledMicros: 250_000n,
          category: "agent",
          state: "settled",
          createdAt: earlier,
        },
      });
      const fact = (key: string, days: number) =>
        create(tx, owner, "facts", {
          key,
          value: "x",
          valueType: "text",
          status: "verified",
          publicUse: true,
          modelUse: true,
          validFrom: iso(-30 * day),
          validUntil: iso(days * day),
        });
      await fact("pricing.promo", 3);
      await fact("event.date", 12);
    });
    const ref = `${owner.projectId}:${today}`;
    await queue("daily_report", ref);
    const job = (await jobOf("daily_report", ref))!;
    await send(job.id);

    expect(sent().map((c) => c.method)).toEqual(["sendMessage"]);
    const text = textOf(sent()[0]!);
    expect(text).toContain("Tagesbericht");
    expect(text).toContain("Veröffentlicht: 3");
    expect(text).toContain("Gestoppt: 1");
    expect(text).toContain("Abgelehnt: 2");
    expect(text).toContain("Fehlgeschlagene Schritte: 2");
    expect(text).toContain("Entfallene Beiträge: 5");
    expect(text).toContain("Blockierte Beiträge: 1");
    expect(text).toContain("Kosten heute: 1,50 USD");
    // The month is the budget month (UTC, M4); the report time 20:00 Berlin falls on the same UTC date.
    const [year, month] = today.split("-").map(Number);
    const earlierSameMonth =
      now - 36 * 60 * MINUTE >= Date.UTC(year!, month! - 1, 1);
    const earlierToday =
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(
        new Date(now - 36 * 60 * MINUTE),
      ) === today;
    expect(text).toContain(
      `Kosten Monat (UTC): ${earlierSameMonth ? "1,75" : "1,50"} USD`,
    );
    expect(earlierToday).toBe(false);
    expect(text).toContain("pricing.promo");
    expect(text).not.toContain("event.date");
    expect(text).not.toContain("beta.access");
  });

  it("plans the daily report once per local day at 20:00", async () => {
    await linkBot();
    const plan = (iso: string) =>
      h.run((tx) => planDailyReport(tx, project.owner, new Date(iso)));
    // 20:00 in Berlin on 2026-10-09 is 18:00 UTC.
    await plan("2026-10-09T17:59:00.000Z");
    expect(await jobsOf("daily_report")).toEqual([]);
    await plan("2026-10-09T18:00:00.000Z");
    // The sweep runs again and again: still one report for the day.
    await plan("2026-10-09T18:05:00.000Z");
    await h.run((tx) =>
      sweepProject(tx, h.worker(), new Date("2026-10-09T21:00:00.000Z")),
    );
    const day = await jobsOf("daily_report");
    expect(day.map((job) => job.idempotencyKey)).toEqual([
      `notify:daily_report:${project.owner.projectId}:2026-10-09`,
    ]);
    // The next day is a new report.
    await plan("2026-10-10T18:30:00.000Z");
    expect(await jobsOf("daily_report")).toHaveLength(2);
    // No bot, no report.
    await h.run(async (tx) => {
      for (const row of await list(tx, project.owner, "telegram_connections"))
        await update(tx, project.owner, row, {
          ...data(row),
          status: "disabled",
        });
    });
    await plan("2026-10-11T18:30:00.000Z");
    expect(await jobsOf("daily_report")).toHaveLength(2);
  });

  it("wakes the sweep at the next report time", async () => {
    await linkBot();
    const next = (iso: string) =>
      h.run((tx) => nextDailyReportAt(tx, project.owner, new Date(iso)));
    expect(await next("2026-10-09T10:00:00.000Z")).toEqual(
      new Date("2026-10-09T18:00:00.000Z"),
    );
    expect(await next("2026-10-09T19:00:00.000Z")).toEqual(
      new Date("2026-10-10T18:00:00.000Z"),
    );
    // The project's own clock: Berlin leaves summer time on 2026-10-25.
    expect(await next("2026-10-25T10:00:00.000Z")).toEqual(
      new Date("2026-10-25T19:00:00.000Z"),
    );
    const sweepAt = await h.run((tx) =>
      nextSweepAt(tx, project.owner, new Date("2026-10-09T10:00:00.000Z")),
    );
    expect(
      sweepAt && sweepAt.valueOf() <= Date.parse("2026-10-09T18:00:00.000Z"),
    ).toBe(true);
  });

  describe("notices from the agent run", () => {
    it("reports a draft left for the owner", async () => {
      await linkBot();
      await h.makeAssignment();
      const planned = await reviewedRun();
      await h.run((tx) =>
        tx.project.update({
          where: { id: project.owner.projectId },
          data: { paused: true },
        }),
      );
      await runAgentTask(h.worker(), planned.review.id);
      const left = await jobsOf("needs_owner");
      expect(left).toHaveLength(2);
      calls.length = 0;
      // The project is paused: the notice still goes out.
      await send(left[0]!.id);
      expect(textOf(sent()[0]!)).toContain("Orbit");
      expect(textOf(sent()[0]!)).toContain("PROJECT_PAUSED");
      expect(markup(sent()[0]!)[0]!.url).toContain("/approvals");
      // A second pass over the same review adds no new notice.
      await runAgentTask(h.worker(), planned.review.id);
      expect(await jobsOf("needs_owner")).toHaveLength(2);
    });

    it("reports a dropped deliverable", async () => {
      await linkBot();
      await h.makeAssignment();
      const planned = await reviewedRun();
      // Another post fills the day's quota together with the run's second slot.
      await h.run((tx) =>
        create(tx, project.owner, "publications", {
          contentId: "synthetic-other-post",
          channel: X,
          status: "intent_created",
          scheduledAt: new Date(
            Date.parse(planned.slots[0]!.at) + 120 * MINUTE,
          ).toISOString(),
          test: true,
        }),
      );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(planned.slots[0]!.at) - 150 * MINUTE);
      await reviewTask(planned.review.id, () => ({ verdict: "approve" }));
      vi.useRealTimers();
      const dropped = await jobsOf("dropped");
      expect(dropped).toHaveLength(1);
      await send(dropped[0]!.id);
      expect(sent().map((c) => c.method)).toEqual(["sendMessage"]);
      expect(textOf(sent()[0]!)).toContain("Kein freier Slot");
      expect(textOf(sent()[0]!)).toContain("Synthetic X");
    });

    it("reports a Postiz error", async () => {
      const saved = {
        EXECUTION_MODE: process.env.EXECUTION_MODE,
        ENABLE_EXTERNAL_WRITES: process.env.ENABLE_EXTERNAL_WRITES,
        PUBLISHER_INSTANCE_ID: process.env.PUBLISHER_INSTANCE_ID,
      };
      try {
        process.env.EXECUTION_MODE = "live";
        process.env.ENABLE_EXTERNAL_WRITES = "true";
        process.env.PUBLISHER_INSTANCE_ID = "synthetic-publisher";
        provider.liveIndex = true;
        provider.createPost.mockRejectedValue(
          new ConnectorError("PROVIDER_REJECTED", "rejected"),
        );
        await h.run(async (tx) => {
          const row = (await list(tx, project.owner, "connectors"))[0]!;
          await update(tx, project.owner, row, {
            ...data(row),
            status: "write_verified",
            baseUrl: "https://postiz.example.invalid",
            encryptedCredential: encrypt(
              "synthetic-token",
              process.env.CREDENTIAL_KEY!,
            ),
            writeVerifiedIntegrationIds: [X],
            writeVerifiedInstanceId: "synthetic-publisher",
          });
        });
        await linkBot();
        await h.makeAssignment();
        const planned = await reviewedRun();
        await reviewTask(planned.review.id, () => ({ verdict: "approve" }));
        const [pub] = (await h.rows("publications")).sort((a, b) =>
          String(a.scheduledAt).localeCompare(String(b.scheduledAt)),
        );
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.parse(pub!.scheduledAt) + MINUTE);
        await dispatchPublication(project.owner, pub!.id);
        vi.useRealTimers();
        expect((await h.rows("publications"))[0]!.id).toBeTruthy();
        const jobs = await jobsOf("postiz_error");
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.idempotencyKey).toBe(`notify:postiz_error:${pub!.id}`);
        await send(jobs[0]!.id);
        expect(textOf(sent().at(-1)!)).toContain("Postiz");
      } finally {
        for (const [key, value] of Object.entries(saved))
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    });
  });
  describe("notices for stopped deliverables (I4)", () => {
    const audits = (action: string) =>
      h.run((tx) =>
        tx.auditEvent.findMany({
          where: { projectId: project.owner.projectId, action },
        }),
      );

    it("reports the slots that are not free at planning, once per run", async () => {
      await linkBot();
      // One post a day: the run's 17:00 slot has no room.
      await h.setPolicy({ maxPerDay: 1 });
      await h.makeAssignment({ name: "Zwei Posts am Tag" });
      await h.run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
      await h.run((tx) =>
        planAssignmentRuns(tx, project.owner, tomorrowMorning()),
      );
      const [runRow] = await h.rows("assignment_runs");
      expect(runRow!.unavailable).toHaveLength(1);
      const jobs = await jobsOf("slots_unavailable");
      expect(jobs.map((job) => job.idempotencyKey)).toEqual([
        `notify:slots_unavailable:${runRow!.id}`,
      ]);
      await send(jobs[0]!.id);
      const text = textOf(sent()[0]!);
      expect(text).toContain("Kein freier Slot");
      expect(text).toContain("Zwei Posts am Tag");
      expect(text).toContain("Synthetic X");
      expect(text).toContain("17:00");
    });

    it("reports a day that gets no run because none of its slots is free, once (R75)", async () => {
      await linkBot();
      // No post a day: neither slot has room.
      await h.setPolicy({ maxPerDay: 0 });
      const assignment = await h.makeAssignment({ name: "Zwei Posts am Tag" });
      for (let pass = 0; pass < 2; pass++)
        expect(
          await h.run((tx) =>
            planAssignmentRuns(tx, project.owner, tomorrowMorning()),
          ),
        ).toEqual({ created: 0 });
      expect(await h.rows("assignment_runs")).toEqual([]);
      const jobs = await jobsOf("slots_unavailable");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.idempotencyKey).toMatch(
        new RegExp(
          `^notify:slots_unavailable:${assignment.id}:\\d{4}-\\d{2}-\\d{2}$`,
        ),
      );
      await send(jobs[0]!.id);
      const text = textOf(sent()[0]!);
      expect(text).toContain("Kein freier Slot");
      expect(text).toContain("Zwei Posts am Tag");
      expect(text).toContain("2 Beiträge entfallen");
      expect(text).toContain("17:00");
    });

    it("reports failed steps and dropped briefs in one notice when the run ends", async () => {
      await linkBot();
      await h.makeAssignment({ name: "Zwei Posts am Tag" });
      // The strategy briefed the first slot with a fact that is not usable and left the second uncovered.
      const planned = await h.planWithBriefs((slots) => [
        h.brief(slots[0]!, { factKeys: ["no.such.fact"] }),
      ]);
      const strategy = await h.task("strategy");
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "agent_tasks", strategy.id);
        await update(tx, project.owner, row, {
          ...data(row),
          output: {
            ...data(row).output,
            dropped: [
              {
                channel: X,
                slotAt: planned.slots[1]!.at,
                code: "AGENT_UNKNOWN_FACT",
              },
            ],
            uncovered: [{ channel: X, slotAt: planned.slots[1]!.at }],
          },
        });
      });
      await runAgentTask(h.worker(), (await h.task(`copywriter:${X}`)).id);
      expect(await h.task(`copywriter:${X}`)).toMatchObject({
        status: "failed",
        errorCode: "FACT_NOT_USABLE",
      });
      const [ended] = await h.rows("assignment_runs");
      expect(ended!.status).toBe("partial");
      const jobs = await jobsOf("run_problem");
      expect(jobs.map((job) => job.idempotencyKey)).toEqual([
        `notify:run_problem:${planned.runId}`,
      ]);
      // Counted for the daily report: analytics, research and the copywriter failed; one slot was not covered.
      expect(
        (await audits("assignment.run_problems")).map((a) => a.metadata),
      ).toEqual([
        expect.objectContaining({
          runId: planned.runId,
          failedSteps: 3,
          droppedDeliverables: 1,
        }),
      ]);
      // The run is over: going through it again adds nothing.
      await h.run((tx) => startReadySteps(tx, project.owner, planned.runId));
      expect(await jobsOf("run_problem")).toHaveLength(1);

      await send(jobs[0]!.id);
      const text = textOf(sent()[0]!);
      expect(text).toContain("Zwei Posts am Tag");
      expect(text).toContain("Fakten fehlen");
      expect(text).toContain("FACT_NOT_USABLE");
      expect(text).toContain("AGENT_UNKNOWN_FACT");
      expect(text).toContain("Synthetic X");
      expect(text).toContain("Übersprungen: review");
    });

    it("sends no run notice for a run without problems or with Orbit Agents off", async () => {
      await linkBot();
      await h.makeAssignment();
      const planned = await h.planWithBriefs((slots) =>
        slots.map((slot) => h.brief(slot)),
      );
      // A clean run: every step done, one wave after the other.
      for (let wave = 0; wave < 4; wave++)
        await h.run(async (tx) => {
          for (const row of await list(tx, project.owner, "agent_tasks"))
            await update(tx, project.owner, row, {
              ...data(row),
              status: "done",
              errorCode: null,
            });
          await startReadySteps(tx, project.owner, planned.runId);
        });
      expect((await h.rows("assignment_runs"))[0]!.status).toBe("done");
      expect(await jobsOf("run_problem")).toEqual([]);
      expect(await audits("assignment.run_problems")).toEqual([]);
    });

    it("reports a post blocked at the claim after its preview, but not a stopped one", async () => {
      await linkBot();
      await h.makeAssignment();
      const planned = await reviewedRun();
      await planned.run();
      const pubs = (await h.rows("publications")).sort((a, b) =>
        String(a.scheduledAt).localeCompare(String(b.scheduledAt)),
      );
      expect(pubs).toHaveLength(2);
      // The owner stops the second post; the policy no longer covers the channel of the first.
      await h.run(async (tx) => {
        const row = await entity(
          tx,
          project.owner,
          "publications",
          pubs[1]!.id,
        );
        await update(tx, project.owner, row, {
          ...data(row),
          vetoedAt: new Date().toISOString(),
        });
      });
      await h.setPolicy({ channels: ["other-int"] });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.parse(pubs[1]!.scheduledAt) + MINUTE);
      for (const pub of [...pubs, ...pubs])
        await h.run((tx) => claimPublication(tx, project.owner, pub.id));
      vi.useRealTimers();
      expect((await h.rows("publications")).map((pub) => pub.status)).toEqual([
        "blocked_dependency",
        "blocked_dependency",
      ]);
      const jobs = await jobsOf("blocked");
      expect(jobs.map((job) => job.idempotencyKey)).toEqual([
        `notify:blocked:${pubs[0]!.id}`,
      ]);
      expect(await audits("publication.claim_blocked")).toHaveLength(1);
      await send(jobs[0]!.id);
      const text = textOf(sent()[0]!);
      expect(text).toContain("blockiert");
      expect(text).toContain("Synthetic X");
      expect(text).toContain("SCOPE_NOT_ALLOWED");
    });

    it("reports a draft the agent approved that waits for the owner while agent authority is off (R71)", async () => {
      process.env.ORBIT_AGENT_REVIEW_AUTHORITY = "false";
      await linkBot();
      await h.makeAssignment();
      const planned = await reviewedRun();
      await planned.run();
      expect(await jobsOf("preview")).toEqual([]);
      const drafts = (await h.rows("content")).filter(
        (row) => row.assignmentRunId === planned.runId,
      );
      expect(drafts.map((row) => row.status)).toEqual([
        "needs_review",
        "needs_review",
      ]);
      const waiting = await jobsOf("needs_owner");
      expect(waiting.map((job) => job.idempotencyKey).sort()).toEqual(
        drafts
          .map((row) => `notify:needs_owner:${row.id}:${planned.review.id}`)
          .sort(),
      );
      // A second pass over the same review adds no second notice.
      await runAgentTask(h.worker(), planned.review.id);
      expect(await jobsOf("needs_owner")).toHaveLength(2);

      await send(waiting[0]!.id);
      const text = textOf(sent()[0]!);
      expect(text).toContain("wartet auf deine Freigabe");
      expect(text).toContain("geprüft");
      expect(markup(sent()[0]!)[0]!.url).toContain("/approvals");
      // Released (or otherwise decided) before the message went out: nothing to say.
      const other = waiting[1]!;
      const contentId = String(other.idempotencyKey).split(":")[2]!;
      await h.run(async (tx) => {
        const row = await entity(tx, project.owner, "content", contentId);
        await update(tx, project.owner, row, {
          ...data(row),
          status: "reviewed",
        });
      });
      await send(other.id);
      expect(sent()).toHaveLength(1);
      expect(
        (await h.rows("jobs")).find((job) => job.id === other.id)!.notification,
      ).toMatchObject({ outcome: "skipped", reason: "STALE" });
    });
  });
});
