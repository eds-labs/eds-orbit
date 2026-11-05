import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Voice in the personal assistant (ADR 0024, plan Phase 4 WP4.5-WP4.7):
// the routes' gates and caps, reservation before every speech call and
// settlement with actual usage, no retry of an unknown outcome, the
// provider allow-list, merge of the voice settings, and that audio never
// reaches the database or files. Every provider is a fake: the speech
// adapter is injected, and the chat model is scripted.

const mocked = vi.hoisted(() => ({
  requests: [] as Array<{
    instructions: string;
    tools: any[];
    input: unknown[];
  }>,
  allowList: null as null | string[],
  fileWrites: [] as unknown[],
}));
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../../packages/ai/src/index.ts")>()),
  embed: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  streamChat: vi.fn(
    async (request: {
      instructions: string;
      tools: any[];
      input: unknown[];
    }) => {
      mocked.requests.push({
        instructions: request.instructions,
        tools: request.tools,
        input: [...request.input],
      });
      const output = [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "response.output_text.delta", delta: "Done." };
          yield {
            type: "response.completed",
            response: {
              id: randomUUID(),
              usage: { input_tokens: 100, output_tokens: 20 },
              output,
            },
          };
        },
      };
    },
  ),
}));
vi.mock("../src/platform/ai/data-class.ts", async (original) => {
  const real =
    await original<typeof import("../src/platform/ai/data-class.ts")>();
  return {
    ...real,
    providersForData: (
      dataClass: Parameters<typeof real.providersForData>[0],
    ) => (mocked.allowList as never) ?? real.providersForData(dataClass),
  };
});
// Records every file write of the process while the routes run.
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const record =
    <T extends (...args: any[]) => any>(fn: T) =>
    (...args: Parameters<T>) => {
      mocked.fileWrites.push(args);
      return fn(...args);
    };
  return {
    ...real,
    default: {
      ...real,
      writeFile: record(real.writeFile),
      appendFile: record(real.appendFile),
    },
    writeFile: record(real.writeFile),
    appendFile: record(real.appendFile),
  };
});
vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const record =
    <T extends (...args: any[]) => any>(fn: T) =>
    (...args: Parameters<T>) => {
      mocked.fileWrites.push(args);
      return fn(...args);
    };
  const patched = {
    writeFile: record(real.writeFile),
    writeFileSync: record(real.writeFileSync),
    appendFileSync: record(real.appendFileSync),
    createWriteStream: record(real.createWriteStream),
  };
  return { ...real, ...patched, default: { ...real, ...patched } };
});

import { authDb, closeDatabase } from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import {
  fakeSpeechProvider,
  mp4Recording,
  webmRecording,
} from "../../../packages/ai/src/audio-fixtures.test-helpers.ts";
import {
  SpeechProviderError,
  type SpeechProvider,
} from "../../../packages/ai/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { moduleRegistry } from "../src/modules/registry.ts";
import { saveOpenAiConfiguration } from "../src/modules/openai-configuration.ts";
import { runChatJob } from "../src/platform/assistant/chat-runner.ts";
import {
  createConversation,
  sendMessage,
} from "../src/platform/assistant/chat.ts";
import { ensurePersonalSpace } from "../src/platform/assistant/personal-space.ts";
import {
  setSpeechProviderFactory,
  speechTextOf,
} from "../src/platform/assistant/voice.ts";
import { saveOrganizationAiBudget } from "../src/platform/administration/ai-budget.ts";
import {
  defaultEntitlements,
  setEntitlementsResolver,
} from "../src/platform/entitlements/entitlements.ts";
import { userScoped } from "../src/platform/tenancy/scope.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const FLAGS: Record<string, string> = {
  ORBIT_PERSONAL_ASSISTANT: "true",
  ORBIT_VOICE: "true",
  EXECUTION_MODE: "test",
  ENABLE_EXTERNAL_WRITES: "false",
};
const USD = 1_000_000;
const MARKER = "ORBIT-VOICE-AUDIO-MARKER-7f3a";
const ROUTES = {
  settings: "/api/assistant/voice-settings",
  transcriptions: "/api/assistant/transcriptions",
  speech: "/api/assistant/speech",
};

type Person = { id: string; email: string; cookie: string };

describe("speech text of a message", () => {
  it("reads the visible answer without Markdown, code or link targets, and cards by title only", () => {
    const text = speechTextOf(
      "## Status\n\n**Two** tickets are open, see [the queue](https://example.invalid/q).\n\n```js\nsecret()\n```\n- first `item`",
      [
        { kind: "status", label: "Ticket 12 waits for you", href: "/p/x" },
        {
          kind: "context_proposal",
          label: "Remember: short answers",
          contextProposal: { text: "hidden detail" },
        },
      ],
    );
    expect(text).toContain("Status");
    expect(text).toContain("Two tickets are open, see the queue.");
    expect(text).toContain("first item");
    expect(text).toContain("Ticket 12 waits for you.");
    expect(text).toContain("Remember: short answers.");
    expect(text).not.toMatch(/https?:|secret\(\)|\*\*|##|hidden detail/);
  });
});

describe.skipIf(!enabled)("Voice routes (ADR 0024)", () => {
  const saved: Record<string, string | undefined> = {};
  const password = randomBytes(24).toString("base64url");
  const origin = process.env.APP_ORIGIN!;
  let app: Awaited<ReturnType<typeof buildServer>>;
  const users: string[] = [];
  let workspaceId = "";
  let otherWorkspaceId = "";
  let owner: Person;
  let member: Person;
  let personal: Scope;
  let ownerPersonal: Scope;
  const calls = { transcribe: 0, synthesize: 0, texts: [] as string[] };
  let behavior: "ok" | "unknown" | "rejected" = "ok";

  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  async function signUp(name: string): Promise<Person> {
    const email = `${randomUUID()}@example.invalid`;
    const r = await makeAuth().api.signUpEmail({
      body: { email, name, password },
    });
    users.push(r.user.id);
    return { id: r.user.id, email, cookie: "" };
  }
  async function signIn(person: Person) {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email: person.email, password },
    });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"];
    person.cookie = (Array.isArray(set) ? set : [set])
      .filter(Boolean)
      .map((c) => c!.split(";")[0])
      .join("; ");
  }
  const json = (
    method: "GET" | "PUT" | "POST",
    url: string,
    who: Person | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin,
        [CLIENT_IP_HEADER]: ip(),
        ...(who ? { cookie: who.cookie } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const upload = (
    audio: Uint8Array,
    who: Person | null = member,
    type = "audio/webm",
    query = "",
  ) =>
    app.inject({
      method: "POST",
      url: `${ROUTES.transcriptions}${query}`,
      headers: {
        origin,
        [CLIENT_IP_HEADER]: ip(),
        "content-type": type,
        ...(who ? { cookie: who.cookie } : {}),
      },
      payload: Buffer.from(audio),
    });
  const reservations = (scope: Scope) =>
    userScoped(scope, (tx) =>
      tx.budgetReservation.findMany({
        where: { projectId: scope.projectId },
        orderBy: { createdAt: "asc" },
      }),
    );
  const messageCount = (scope: Scope) =>
    userScoped(scope, (tx) =>
      tx.chatMessage.count({ where: { projectId: scope.projectId } }),
    );
  const entityKinds = (scope: Scope) =>
    userScoped(scope, (tx) =>
      tx.entity.findMany({
        where: { projectId: scope.projectId },
        select: { id: true, kind: true },
      }),
    );

  const fake = (): SpeechProvider => {
    const base = fakeSpeechProvider("What is due in my projects?");
    return {
      provider: "openai",
      async transcribe(input, signal) {
        calls.transcribe++;
        if (behavior === "unknown") throw new SpeechProviderError("unknown");
        if (behavior === "rejected")
          throw new SpeechProviderError("rejected", 400);
        const result = await base.transcribe(input, signal);
        return { ...result, durationSeconds: 11 };
      },
      async synthesize(input, signal) {
        calls.synthesize++;
        calls.texts.push(input.text);
        if (behavior === "unknown") throw new SpeechProviderError("unknown");
        return base.synthesize(input, signal);
      },
    };
  };

  async function assistantMessage(
    scope: Scope,
    text: string,
    cards: unknown[] = [],
    role = "assistant",
  ) {
    return userScoped(scope, async (tx) => {
      const conversation = await tx.chatConversation.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          userId: scope.userId,
        },
      });
      return tx.chatMessage.create({
        data: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          userId: scope.userId,
          conversationId: conversation.id,
          sequence: 1,
          role,
          text,
          cards: cards as never,
        },
      });
    });
  }

  /** Rows of the personal space that hold the audio marker, plus any platform file. */
  async function markerRows(scope: Scope) {
    const like = `%${MARKER}%`;
    const rows = await userScoped(
      scope,
      (tx) => tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT (
        (SELECT count(*) FROM "Entity" WHERE "projectId"=${scope.projectId}::uuid AND data::text LIKE ${like}) +
        (SELECT count(*) FROM "ChatMessage" WHERE "projectId"=${scope.projectId}::uuid AND text LIKE ${like}) +
        (SELECT count(*) FROM "AuditEvent" WHERE "projectId"=${scope.projectId}::uuid AND metadata::text LIKE ${like}) +
        (SELECT count(*) FROM "File" WHERE "projectId"=${scope.projectId}::uuid)
      )::bigint AS n`,
    );
    return Number(rows[0]!.n);
  }

  beforeAll(async () => {
    for (const [key, value] of Object.entries(FLAGS)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    app = await buildServer();
    owner = await signUp("Synthetic voice owner");
    member = await signUp("Synthetic voice member");
    workspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic voice org",
          members: {
            create: [
              { userId: owner.id, role: "owner" },
              { userId: member.id, role: "viewer" },
            ],
          },
        },
      })
    ).id;
    otherWorkspaceId = (
      await authDb.workspace.create({
        data: {
          name: "Synthetic voice other org",
          members: { create: [{ userId: owner.id, role: "owner" }] },
        },
      })
    ).id;
    for (const [user, set] of [
      [member, (s: Scope) => (personal = s)],
      [owner, (s: Scope) => (ownerPersonal = s)],
    ] as const) {
      const space = await ensurePersonalSpace(
        workspaceId,
        user.id,
        moduleRegistry(),
      );
      const scope: Scope = {
        workspaceId,
        projectId: space.projectId,
        userId: user.id,
        role: "owner",
      };
      set(scope);
      await userScoped(scope, (tx) =>
        saveOpenAiConfiguration(tx, scope, {
          apiKey: "synthetic-no-provider-call-key",
          verifiedModels: [
            "synthetic-model",
            "gpt-4o-mini-transcribe",
            "tts-1",
          ],
          rateCard: {
            "synthetic-model": {
              inputMicrosPerMillion: 1000,
              outputMicrosPerMillion: 1000,
              verifiedAt: new Date().toISOString(),
            },
          },
          modelRoutes: {
            fast: "synthetic-model",
            standard: "synthetic-model",
            quality: "synthetic-model",
            escalation: "synthetic-model",
          },
        }),
      );
    }
    await saveOrganizationAiBudget(owner.id, workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: 5 * USD,
    });
    setSpeechProviderFactory(() => fake());
    await signIn(member);
    await signIn(owner);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    setSpeechProviderFactory();
    setEntitlementsResolver();
    for (const id of [workspaceId, otherWorkspaceId])
      if (id)
        await authDb.workspace.delete({ where: { id } }).catch(() => null);
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  beforeEach(() => {
    behavior = "ok";
    calls.transcribe = 0;
    calls.synthesize = 0;
    calls.texts = [];
    mocked.requests = [];
    mocked.allowList = null;
  });

  it("answers 404 for every route while ORBIT_VOICE is off, before authentication", async () => {
    process.env.ORBIT_VOICE = "false";
    try {
      expect((await json("GET", ROUTES.settings, member)).statusCode).toBe(404);
      expect(
        (await json("PUT", ROUTES.settings, member, { autoSend: true }))
          .statusCode,
      ).toBe(404);
      expect((await upload(webmRecording(2), null)).statusCode).toBe(404);
      expect(
        (await json("POST", ROUTES.speech, null, { messageId: randomUUID() }))
          .statusCode,
      ).toBe(404);
    } finally {
      process.env.ORBIT_VOICE = "true";
    }
    expect(calls.transcribe + calls.synthesize).toBe(0);
  });

  it("refuses anonymous users, other organizations, switched-off members and the missing entitlement", async () => {
    expect((await json("GET", ROUTES.settings, null)).statusCode).toBe(401);
    expect((await upload(webmRecording(2), null)).statusCode).toBe(401);
    // Someone else's organization is not the user's: no space is named or found.
    expect(
      (
        await json(
          "GET",
          `${ROUTES.settings}?workspaceId=${otherWorkspaceId}`,
          member,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await upload(
          webmRecording(2),
          member,
          "audio/webm",
          `?workspaceId=${randomUUID()}`,
        )
      ).statusCode,
    ).toBe(404);

    setEntitlementsResolver(() => ({
      ...defaultEntitlements(),
      assistantVoice: false,
    }));
    try {
      const status = await json("GET", ROUTES.settings, member);
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        available: false,
        reason: "VOICE_ENTITLEMENT",
      });
      const refused = await upload(webmRecording(2));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("VOICE_ENTITLEMENT");
      expect(
        (await json("POST", ROUTES.speech, member, { messageId: randomUUID() }))
          .statusCode,
      ).toBe(403);
      expect(
        (await json("PUT", ROUTES.settings, member, { autoSend: true }))
          .statusCode,
      ).toBe(403);
    } finally {
      setEntitlementsResolver();
    }
    await authDb.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: member.id } },
      data: { assistantEnabled: false },
    });
    try {
      const refused = await upload(webmRecording(2));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("ASSISTANT_DISABLED_FOR_MEMBER");
    } finally {
      await authDb.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId: member.id } },
        data: { assistantEnabled: true },
      });
    }
    expect(calls.transcribe + calls.synthesize).toBe(0);
  });

  it("reports availability and merges voice settings into assistant_settings", async () => {
    const status = await json("GET", ROUTES.settings, member);
    expect(status.json()).toMatchObject({
      available: true,
      settings: { autoSend: false, autoRead: false },
      limits: {
        maxSeconds: 60,
        maxBytes: 2 * 1024 * 1024,
        maxCharacters: 3000,
      },
      speechToText: { ready: true },
      textToSpeech: { ready: true },
    });
    expect(
      (
        await json("PUT", "/api/assistant/context/settings", member, {
          autoMemory: false,
        })
      ).statusCode,
    ).toBe(200);
    const savedVoice = await json("PUT", ROUTES.settings, member, {
      autoSend: true,
    });
    expect(savedVoice.json()).toEqual({ autoSend: true, autoRead: false });
    expect(
      (await json("PUT", ROUTES.settings, member, { autoRead: true })).json(),
    ).toEqual({ autoSend: true, autoRead: true });
    // Neither save overwrote the other's keys.
    expect(
      (await json("GET", "/api/assistant/context", member)).json().autoMemory,
    ).toBe(false);
    await json("PUT", "/api/assistant/context/settings", member, {
      autoMemory: true,
    });
    expect(
      (await json("GET", ROUTES.settings, member)).json().settings,
    ).toEqual({ autoSend: true, autoRead: true });
    expect(
      (await json("PUT", ROUTES.settings, member, { unknown: 1 })).statusCode,
    ).toBe(400);
    expect((await json("PUT", ROUTES.settings, member, {})).statusCode).toBe(
      400,
    );
    // The owner's settings are their own.
    expect((await json("GET", ROUTES.settings, owner)).json().settings).toEqual(
      { autoSend: false, autoRead: false },
    );
  });

  it("transcribes in memory: reserves the measured estimate, settles the reported duration, stores no audio", async () => {
    const before = await reservations(personal);
    const messagesBefore = await messageCount(personal);
    mocked.fileWrites = [];
    const audio = webmRecording(12, {
      payload: new TextEncoder().encode(MARKER),
    });
    const r = await upload(audio);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      text: "What is due in my projects?",
      durationSeconds: 12,
    });
    expect(calls.transcribe).toBe(1);
    const created = (await reservations(personal)).slice(before.length);
    expect(created).toHaveLength(1);
    // 12 s at USD 0.003 per minute reserved; 11 s reported and settled.
    expect(created[0]).toMatchObject({
      category: "speech_stt",
      taskClass: "speech_to_text",
      model: "gpt-4o-mini-transcribe",
      amountMicros: 600n,
      state: "settled",
      settledMicros: 550n,
    });
    // Nothing of the recording in the database, no file, no file write.
    expect(await markerRows(personal)).toBe(0);
    expect(JSON.stringify(mocked.fileWrites.map(String))).not.toContain(MARKER);
    expect(
      mocked.fileWrites.filter((args) =>
        (args as unknown[]).some(
          (a) => a instanceof Uint8Array && Buffer.from(a).includes(MARKER),
        ),
      ),
    ).toHaveLength(0);
    // The transcript is not a message until the user sends it.
    expect(await messageCount(personal)).toBe(messagesBefore);
    // Safari's MP4 is accepted as well.
    const mp4 = await upload(
      mp4Recording(5, { fragmented: true }),
      member,
      "audio/mp4",
    );
    expect(mp4.statusCode).toBe(200);
  });

  it("rejects wrong types, oversized, unreadable and too long recordings before reserving", async () => {
    const before = (await reservations(personal)).length;
    const wrong = await upload(webmRecording(2), member, "audio/ogg");
    expect(wrong.statusCode).toBe(415);
    expect(wrong.json().error.code).toBe("SPEECH_FORMAT_UNSUPPORTED");
    expect(
      (await upload(webmRecording(2), member, "application/json")).statusCode,
    ).toBe(415);
    const big = await upload(new Uint8Array(2 * 1024 * 1024 + 10), member);
    expect(big.statusCode).toBe(413);
    const garbage = await upload(new Uint8Array(4096).fill(9));
    expect(garbage.statusCode).toBe(422);
    expect(garbage.json().error.code).toBe("SPEECH_UNREADABLE");
    const long = await upload(webmRecording(70));
    expect(long.statusCode).toBe(413);
    expect(long.json().error.code).toBe("SPEECH_TOO_LONG");
    const mismatch = await upload(webmRecording(3), member, "audio/mp4");
    expect(mismatch.json().error.code).toBe("SPEECH_UNREADABLE");
    expect((await upload(new Uint8Array(0))).statusCode).toBeGreaterThanOrEqual(
      400,
    );
    expect(calls.transcribe).toBe(0);
    expect((await reservations(personal)).length).toBe(before);
  });

  it("settles an unknown outcome as unknown without retrying, and a refusal at 0", async () => {
    behavior = "unknown";
    const unknown = await upload(webmRecording(4));
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json().error.code).toBe("SPEECH_OUTCOME_UNKNOWN");
    expect(calls.transcribe).toBe(1);
    const last = (await reservations(personal)).at(-1)!;
    expect(last).toMatchObject({
      category: "speech_stt",
      state: "unknown",
      settledMicros: null,
    });
    behavior = "rejected";
    const rejected = await upload(webmRecording(4));
    expect(rejected.json().error.code).toBe("SPEECH_PROVIDER_REJECTED");
    expect(calls.transcribe).toBe(2);
    expect((await reservations(personal)).at(-1)).toMatchObject({
      state: "settled",
      settledMicros: 0n,
    });
  });

  it("applies the personal-data allow-list and the cap before any call", async () => {
    mocked.allowList = ["anthropic"];
    const refused = await upload(webmRecording(2));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("SPEECH_PROVIDER_NOT_ALLOWED");
    const message = await assistantMessage(personal, "A short answer.");
    expect(
      (
        await json("POST", ROUTES.speech, member, { messageId: message.id })
      ).json().error.code,
    ).toBe("SPEECH_PROVIDER_NOT_ALLOWED");
    expect(
      (await json("GET", ROUTES.settings, member)).json().speechToText,
    ).toEqual({
      ready: false,
      reason: "SPEECH_PROVIDER_NOT_ALLOWED",
    });
    mocked.allowList = null;
    await saveOrganizationAiBudget(owner.id, workspaceId, {
      monthlyMicros: null,
      assistantPerUserMonthlyMicros: null,
    });
    try {
      const noCap = await upload(webmRecording(2));
      expect(noCap.json().error.code).toBe("POLICY_REQUIRED");
    } finally {
      await saveOrganizationAiBudget(owner.id, workspaceId, {
        monthlyMicros: null,
        assistantPerUserMonthlyMicros: 5 * USD,
      });
    }
    expect(calls.transcribe + calls.synthesize).toBe(0);
  });

  it("reads one own answer aloud: capped text, reserved before the call, streamed, nothing stored", async () => {
    const message = await assistantMessage(
      personal,
      `Here is the answer. ${"word ".repeat(1200)}`,
      [{ kind: "status", label: "Ticket 7 needs a reply" }],
    );
    const before = (await reservations(personal)).length;
    const entitiesBefore = new Set(
      (await entityKinds(personal)).map((e) => e.id),
    );
    const r = await json("POST", ROUTES.speech, member, {
      messageId: message.id,
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("audio/mpeg");
    expect(r.headers["x-orbit-speech-truncated"]).toBe("true");
    expect(r.rawPayload.length).toBeGreaterThan(0);
    expect(calls.synthesize).toBe(1);
    expect(calls.texts[0]!.length).toBeLessThanOrEqual(3000);
    expect(calls.texts[0]).toMatch(/^Here is the answer\./);
    const created = (await reservations(personal)).slice(before);
    expect(created).toHaveLength(1);
    const characters = calls.texts[0]!.length;
    expect(Number(r.headers["x-orbit-speech-characters"])).toBe(characters);
    expect(created[0]).toMatchObject({
      category: "speech_tts",
      taskClass: "text_to_speech",
      model: "tts-1",
      amountMicros: BigInt(characters * 15),
      state: "settled",
      settledMicros: BigInt(characters * 15),
    });
    // Only the budget run record is new: no audio, no copy of the text.
    const added = (await entityKinds(personal)).filter(
      (e) => !entitiesBefore.has(e.id),
    );
    expect(added.map((e) => e.kind)).toEqual(["budget_runs"]);

    // Short answers include card titles.
    const short = await assistantMessage(personal, "Done.", [
      { kind: "status", label: "Ticket 7 needs a reply" },
    ]);
    expect(
      (await json("POST", ROUTES.speech, member, { messageId: short.id }))
        .statusCode,
    ).toBe(200);
    expect(calls.texts[1]).toBe("Done.\nTicket 7 needs a reply.");
  });

  it("refuses someone else's message, a user message, an unknown id and settles an unknown stream", async () => {
    const own = await assistantMessage(
      ownerPersonal,
      "The owner's private answer.",
    );
    expect(
      (await json("POST", ROUTES.speech, member, { messageId: own.id }))
        .statusCode,
    ).toBe(404);
    const userMessage = await assistantMessage(
      personal,
      "What I typed",
      [],
      "user",
    );
    expect(
      (await json("POST", ROUTES.speech, member, { messageId: userMessage.id }))
        .statusCode,
    ).toBe(404);
    expect(
      (await json("POST", ROUTES.speech, member, { messageId: randomUUID() }))
        .statusCode,
    ).toBe(404);
    expect(
      (await json("POST", ROUTES.speech, member, { messageId: "nope" }))
        .statusCode,
    ).toBe(400);
    expect(calls.synthesize).toBe(0);
    behavior = "unknown";
    const message = await assistantMessage(personal, "Another answer.");
    const r = await json("POST", ROUTES.speech, member, {
      messageId: message.id,
    });
    expect(r.json().error.code).toBe("SPEECH_OUTCOME_UNKNOWN");
    expect(calls.synthesize).toBe(1);
    expect((await reservations(personal)).at(-1)).toMatchObject({
      category: "speech_tts",
      state: "unknown",
    });
  });

  it("runs a transcript as the same turn as typed text: same tools, instructions and rights", async () => {
    const heard = await upload(webmRecording(3));
    const transcript = heard.json().text as string;
    async function turn(text: string) {
      const thread = (await createConversation(personal)).id;
      const sent = await sendMessage(personal, thread, {
        text,
        clientRequestId: randomUUID(),
      });
      await runChatJob(personal, member.id, sent.runId);
      return mocked.requests.at(-1)!;
    }
    const typed = await turn("What is due in my projects?");
    const spoken = await turn(transcript);
    expect(spoken.instructions).toBe(typed.instructions);
    expect(spoken.tools.map((t: any) => t.name ?? t.type)).toEqual(
      typed.tools.map((t: any) => t.name ?? t.type),
    );
    expect(JSON.stringify(spoken.input.at(-1))).toBe(
      JSON.stringify(typed.input.at(-1)),
    );
  });
});
