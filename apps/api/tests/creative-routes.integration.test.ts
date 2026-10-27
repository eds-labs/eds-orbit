import { randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import {
  generateImage,
  respond,
  IMAGE_SIZES,
} from "../../../packages/ai/src/index.ts";
import {
  CREATIVE_FORMAT_IDS,
  CREATIVE_TEMPLATE_IDS,
  sha256Hex,
} from "../../../packages/creative/src/index.ts";
import { fixtureArt } from "../../../packages/creative/fixtures/demo-brands.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { create, data, entity, list, update } from "../src/shared.ts";
import { CREATIVES } from "../src/modules/marketing/creative/store.ts";
import { addBrandKit } from "./support/package-creative.ts";
import { createPackageProject, IMAGE_MAX } from "./support/package-project.ts";

// Nothing here may reach a real provider: the image and review calls are
// replaced per test, and refuse by default.
vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(),
  generateImage: vi.fn(),
}));

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/** A Postiz channel id no connector knows: no channel rules, so the square format. */
const UNRULED = "unruled-routes-int";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps, throws and textures that turn any room into a calm retreat.",
  cta: "Shop the collection",
};
const CONFIRM = {
  confirmMaximumCostMicros: IMAGE_MAX,
  confirmPromptMayBeSentToProvider: true as const,
};
const PASSING = {
  scores: {
    subject: 4,
    balance: 4,
    legibility: 5,
    brandFit: 4,
    messageFit: 4,
    channelFit: 4,
    value: 3,
  },
  issues: [],
};
const PEOPLE = ["owner", "editor", "viewer", "outsider"] as const;
type Person = (typeof PEOPLE)[number];

describe.skipIf(!enabled)("Creative Studio routes", () => {
  type Project = Awaited<ReturnType<typeof createPackageProject>>;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let a: Project;
  let b: Project;
  let artPng: Buffer;
  const assets = {} as Record<"goodArt" | "flatArt" | "unapprovedArt", string>;
  const people = {} as Record<Person, { id: string; cookie: string }>;
  const origin = () => process.env.APP_ORIGIN!;
  // A fresh documentation address per request: no request shares a rate-limit bucket.
  const freshIp = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;

  const runIn = <T>(project: Project, work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const call = (
    who: Person,
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    options: { project?: Project; ip?: string } = {},
  ) =>
    app.inject({
      method,
      url: `/api/projects/${(options.project ?? a).owner.projectId}/${path}`,
      headers: {
        origin: origin(),
        cookie: people[who].cookie,
        [CLIENT_IP_HEADER]: options.ip ?? freshIp(),
      },
      ...(payload === undefined ? {} : { payload: payload as any }),
    });
  /** An approved raster asset, stored as the upload route stores one. */
  const addAsset = (
    project: Project,
    type: string,
    bytes: Buffer,
    approved = true,
  ) =>
    runIn(project, async (tx) => {
      const row = await create(tx, project.owner, "assets", {
        name: `Synthetic ${type}`,
        type,
        mime: "image/png",
        base64: bytes.toString("base64"),
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        source: "Synthetic fixture",
        license: "Synthetic rights fixture",
        validUses: ["brand", "social"],
        usageApproved: approved,
        assetStatus: approved ? "approved" : "reference",
        // The vision review sends the components to a provider.
        providerUse: approved,
        driveSyncStatus: "LOCAL_ONLY",
      });
      return row.id;
    });
  const newContent = (project: Project = a) =>
    runIn(project, async (tx) => {
      const mission = await create(tx, project.owner, "missions", {
        title: "Autumn evenings",
        status: "active",
        targetAction: "Shop the collection",
      });
      const evidence = await create(tx, project.owner, "evidence", {
        status: "ready",
        purpose: "public",
        facts: [],
        items: [],
      });
      return create(tx, project.owner, "content", {
        title: "Evenings feel softer",
        body: "Evenings feel softer in warm light. Shop the collection.",
        type: "social",
        channel: UNRULED,
        status: "reviewed",
        missionId: mission.id,
        evidenceId: evidence.id,
        claims: [],
      });
    });
  const produceBody = (contentId: string, artAssetId = assets.goodArt) => ({
    contentId,
    template: "lifestyle",
    copy: COPY,
    artAssetId,
  });
  /** A composed creative of the good art, produced by `who` through the route. */
  const produce = async (who: Person = "editor", contentId?: string) => {
    const content = contentId ?? (await newContent()).id;
    const response = await call(who, "POST", "creatives", produceBody(content));
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as {
      id: string;
      contentId: string;
      status: string;
      qa: { verdict: string };
      cost: { reservationIds: string[]; settledMicros: number };
      components: { artAssetId: string };
    };
  };
  const imageProvider = () =>
    vi.mocked(generateImage).mockImplementation((async (
      request: Parameters<typeof generateImage>[0],
    ) => ({
      bytes: artPng,
      model: "gpt-image-2.5-flare",
      size: request.size,
      quality: request.quality,
      background: request.background,
      usage: null,
    })) as unknown as typeof generateImage);
  const reviewer = () =>
    vi.mocked(respond).mockImplementation((async () => ({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(PASSING) }],
        },
      ],
      usage: {
        model: "synthetic-model",
        inputTokens: 1200,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 180,
        reasoningTokens: 0,
        costMicros: 1234,
      },
      responseId: "synthetic-response",
      truncated: false,
    })) as unknown as typeof respond);
  /** Every creative route with plausible ids and a valid body. */
  const everyRoute = (creativeId: string, contentId: string) =>
    [
      ["GET", "creative/options", undefined],
      ["POST", "creatives", produceBody(contentId)],
      ["GET", `creatives/${creativeId}`, undefined],
      ["GET", `content/${contentId}/creative`, undefined],
      ["POST", `creatives/${creativeId}/recompose`, {}],
      ["POST", `creatives/${creativeId}/regenerate-art`, CONFIRM],
      ["POST", `creatives/${creativeId}/review`, {}],
      ["POST", `creatives/${creativeId}/attach`, {}],
    ] as const;
  const reservation = (project: Project, requestId: string) =>
    runIn(project, (tx) =>
      tx.budgetReservation.findFirst({
        where: {
          projectId: project.owner.projectId,
          key: `${project.owner.projectId}:image:${requestId}`,
        },
      }),
    );
  const creativesOf = (project: Project, contentId: string) =>
    runIn(project, async (tx) =>
      (await list(tx, project.owner, CREATIVES)).filter(
        (row) => data(row).contentId === contentId,
      ),
    );

  beforeAll(async () => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    app = await buildServer();
    const auth = makeAuth();
    for (const who of PEOPLE) {
      const email = `${randomUUID()}@example.invalid`;
      const password = randomBytes(24).toString("base64url");
      const user = await auth.api.signUpEmail({
        body: { email, password, name: `Synthetic creative ${who}` },
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: origin(), [CLIENT_IP_HEADER]: freshIp() },
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const cookies = login.headers["set-cookie"];
      people[who] = {
        id: user.user.id,
        cookie: (Array.isArray(cookies) ? cookies : [cookies])
          .map((c) => c!.split(";")[0])
          .join("; "),
      };
    }
    a = await createPackageProject();
    b = await createPackageProject();
    const member = async (
      project: Project,
      who: Person,
      role: "owner" | "editor" | "viewer",
    ) => {
      await authDb.workspaceMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          userId: people[who].id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: project.owner.workspaceId,
          projectId: project.owner.projectId,
          userId: people[who].id,
          role,
        },
      });
    };
    await member(a, "owner", "owner");
    await member(a, "editor", "editor");
    await member(a, "viewer", "viewer");
    // Project B has no brand kit: the options report no configuration.
    await member(b, "owner", "owner");
    // Two corrections: a retried regeneration must not count twice.
    const logo = await addBrandKit(a, {
      maxArtCorrections: 2,
      visualReview: true,
    });
    await runIn(a, async (tx) => {
      const row = await entity(tx, a.owner, "assets", logo.id);
      await update(tx, a.owner, row, { ...data(row), providerUse: true });
    });
    artPng = (await fixtureArt("good", "lumora")).bytes;
    assets.goodArt = await addAsset(a, "photo", artPng);
    assets.flatArt = await addAsset(
      a,
      "photo",
      (await fixtureArt("flat", "lumora")).bytes,
    );
    // Uploaded, never approved.
    assets.unapprovedArt = await addAsset(
      a,
      "photo",
      (await fixtureArt("good", "kestrel")).bytes,
      false,
    );
  });
  beforeEach(() => {
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    vi.mocked(generateImage).mockReset();
    vi.mocked(respond).mockReset();
    vi.mocked(generateImage).mockRejectedValue(
      new Error("REAL_PROVIDER_CALLED"),
    );
    vi.mocked(respond).mockRejectedValue(new Error("REAL_PROVIDER_CALLED"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await a?.cleanup();
    await b?.cleanup();
    await authDb.user.deleteMany({
      where: { id: { in: Object.values(people).map((u) => u.id) } },
    });
    await app?.close();
    await closeDatabase();
  });

  it("routes are hidden while the flag is off", async () => {
    const creative = await produce();
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "false");
    for (const [method, path, payload] of everyRoute(
      creative.id,
      creative.contentId,
    )) {
      const response = await call("owner", method, path, payload);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(response.json().error.code, `${method} ${path}`).toBe("NOT_FOUND");
    }
    // Nothing happened behind the 404.
    vi.stubEnv("ORBIT_CREATIVE_STUDIO", "true");
    const view = await call("owner", "GET", `creatives/${creative.id}`);
    expect(view.json().status).toBe("composed");
    expect(await creativesOf(a, creative.contentId)).toHaveLength(1);
  });

  it("marketing disabled answers MODULE_DISABLED", async () => {
    const off = await createPackageProject();
    try {
      await authDb.workspaceMember.create({
        data: {
          workspaceId: off.owner.workspaceId,
          userId: people.owner.id,
          role: "viewer",
        },
      });
      await authDb.projectMember.create({
        data: {
          workspaceId: off.owner.workspaceId,
          projectId: off.owner.projectId,
          userId: people.owner.id,
          role: "owner",
        },
      });
      vi.stubEnv("ORBIT_MODULES", "true");
      await runIn(off, (tx) =>
        tx.projectModule.create({
          data: {
            workspaceId: off.owner.workspaceId,
            projectId: off.owner.projectId,
            moduleId: "marketing",
            moduleVersion: "1.0.0",
            enabled: false,
            changedBy: off.owner.userId,
          },
        }),
      );
      const id = randomUUID();
      for (const [method, path, payload] of everyRoute(id, id)) {
        const response = await call("owner", method, path, payload, {
          project: off,
        });
        expect(response.statusCode, `${method} ${path}`).toBe(404);
        expect(response.json().error.code, `${method} ${path}`).toBe(
          "MODULE_DISABLED",
        );
      }
    } finally {
      await off.cleanup();
    }
  });

  describe("roles", () => {
    it("lets a viewer read but not change anything", async () => {
      const creative = await produce();
      for (const path of [
        "creative/options",
        `creatives/${creative.id}`,
        `content/${creative.contentId}/creative`,
      ]) {
        const response = await call("viewer", "GET", path);
        expect(response.statusCode, path).toBe(200);
      }
      for (const [method, path, payload] of everyRoute(
        creative.id,
        creative.contentId,
      ).filter(([method]) => method === "POST")) {
        const response = await call("viewer", method, path, payload);
        expect(response.statusCode, path).toBe(403);
        expect(response.json().error.code, path).toBe("FORBIDDEN");
      }
      expect(await creativesOf(a, creative.contentId)).toHaveLength(1);
    });

    it("lets an editor produce, recompose and attach", async () => {
      const content = await newContent();
      const creative = await produce("editor", content.id);
      expect(creative).toMatchObject({
        contentId: content.id,
        status: "composed",
        // The verdict is the quality, the status the lifecycle (R5a).
        qa: { verdict: "pass" },
      });
      const recomposed = await call(
        "editor",
        "POST",
        `creatives/${creative.id}/recompose`,
        { variant: "text_top", options: { textScale: "s" } },
      );
      expect(recomposed.statusCode, recomposed.body).toBe(200);
      expect(recomposed.json()).toMatchObject({
        id: creative.id,
        variant: "text_top",
        options: { textScale: "s" },
        status: "composed",
      });
      const attached = await call(
        "editor",
        "POST",
        `creatives/${creative.id}/attach`,
        {},
      );
      expect(attached.statusCode, attached.body).toBe(200);
      const view = await call("editor", "GET", `creatives/${creative.id}`);
      expect(view.json()).toMatchObject({
        status: "attached",
        qa: { verdict: "pass" },
      });
      const post = await runIn(a, async (tx) =>
        data(await entity(tx, a.owner, "content", content.id)),
      );
      // The post carries the rendition, and its review ran again.
      expect(post).toMatchObject({
        creativeId: creative.id,
        assetId: attached.json().assetId,
        review: { valid: expect.any(Boolean) },
      });
    });

    it("keeps paid art, the review and accepting findings with the owner", async () => {
      const creative = await produce();
      const generate = imageProvider();
      reviewer();
      for (const path of ["regenerate-art", "review"]) {
        const response = await call(
          "editor",
          "POST",
          `creatives/${creative.id}/${path}`,
          path === "review" ? {} : CONFIRM,
        );
        expect(response.statusCode, path).toBe(403);
        expect(response.json().error.code, path).toBe("FORBIDDEN");
      }
      // New art for a new creative is the owner's decision, too.
      const paid = await call("editor", "POST", "creatives", {
        contentId: (await newContent()).id,
        template: "lifestyle",
        copy: COPY,
        generateArt: CONFIRM,
      });
      expect(paid.statusCode).toBe(403);
      expect(paid.json().error.code).toBe("OWNER_REQUIRED");
      // A creative with findings: an editor cannot accept them.
      const flat = await call(
        "editor",
        "POST",
        "creatives",
        produceBody((await newContent()).id, assets.flatArt),
      );
      expect(flat.statusCode, flat.body).toBe(201);
      const weak = flat.json() as { id: string; status: string };
      expect(weak.status).toBe("needs_owner");
      const plain = await call(
        "editor",
        "POST",
        `creatives/${weak.id}/attach`,
        {},
      );
      expect(plain.statusCode).toBe(409);
      expect(plain.json().error.code).toBe("CREATIVE_QA_FAILED");
      const accepting = await call(
        "editor",
        "POST",
        `creatives/${weak.id}/attach`,
        { acceptQaFindings: true },
      );
      expect(accepting.statusCode).toBe(403);
      expect(accepting.json().error.code).toBe("OWNER_REQUIRED");
      expect(generate).not.toHaveBeenCalled();
      expect(vi.mocked(respond)).not.toHaveBeenCalled();
      // The owner may.
      const owned = await call("owner", "POST", `creatives/${weak.id}/attach`, {
        acceptQaFindings: true,
      });
      expect(owned.statusCode, owned.body).toBe(200);
      expect(
        (await call("owner", "GET", `creatives/${weak.id}`)).json(),
      ).toMatchObject({
        status: "attached",
        // Attached with findings: the verdict still says so (R5a).
        qa: { verdict: "needs_owner" },
      });
    });

    it("lets the owner regenerate the art and review the rendition", async () => {
      const creative = await produce();
      const generate = imageProvider();
      const respondMock = reviewer();
      const regenerated = await call(
        "owner",
        "POST",
        `creatives/${creative.id}/regenerate-art`,
        { ...CONFIRM, correction: { kind: "subject_larger" } },
      );
      expect(regenerated.statusCode, regenerated.body).toBe(200);
      expect(regenerated.json()).toMatchObject({
        id: creative.id,
        status: "needs_rights",
      });
      expect(regenerated.json().components.artAssetId).not.toBe(
        creative.components.artAssetId,
      );
      expect(generate).toHaveBeenCalledTimes(1);
      expect(IMAGE_SIZES).toContain(
        (generate.mock.calls[0]![0] as { size: string }).size,
      );
      // A review of another creative, as the rendition is judged once.
      const other = await produce("owner");
      const reviewed = await call(
        "owner",
        "POST",
        `creatives/${other.id}/review`,
        {},
      );
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect(reviewed.json().qa.vision).toMatchObject({ verdict: "pass" });
      expect(respondMock).toHaveBeenCalledTimes(1);
      const again = await call(
        "owner",
        "POST",
        `creatives/${other.id}/review`,
        {},
      );
      expect(again.statusCode).toBe(200);
      expect(respondMock).toHaveBeenCalledTimes(1);
    });
  });

  it("outsider learns nothing", async () => {
    const creative = await produce();
    for (const [method, path, payload] of everyRoute(
      creative.id,
      creative.contentId,
    )) {
      const response = await call("outsider", method, path, payload);
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      expect(response.json().error.code, `${method} ${path}`).toBe("NOT_FOUND");
    }
    // A member of another project learns nothing about this project's ids.
    for (const path of [
      `creatives/${creative.id}`,
      `content/${creative.contentId}/creative`,
    ]) {
      const response = await call("owner", "GET", path, undefined, {
        project: b,
      });
      expect(response.statusCode, path).toBe(404);
      expect(response.json().error.code, path).toBe("NOT_FOUND");
    }
    const foreign = await call(
      "owner",
      "POST",
      `creatives/${creative.id}/recompose`,
      {},
      { project: b },
    );
    expect(foreign.statusCode).toBe(404);
  });

  describe("options", () => {
    it("options list seven templates and four formats", async () => {
      const response = await call("viewer", "GET", "creative/options");
      expect(response.statusCode, response.body).toBe(200);
      const options = response.json();
      expect(options.templates.map((t: { id: string }) => t.id)).toEqual([
        ...CREATIVE_TEMPLATE_IDS,
      ]);
      expect(options.templates).toHaveLength(7);
      expect(Object.keys(options.formats).sort()).toEqual(
        [...CREATIVE_FORMAT_IDS].sort(),
      );
      expect(Object.keys(options.formats)).toHaveLength(4);
      expect(options.formats.square).toMatchObject({
        id: "square",
        width: 1080,
        height: 1080,
      });
      expect(options.defaultChannelFormats).toMatchObject({
        instagram: ["feed_portrait"],
        x: ["landscape"],
      });
      const lifestyle = options.templates.find(
        (t: { id: string }) => t.id === "lifestyle",
      );
      expect(lifestyle).toMatchObject({
        needs: { art: "required", product: "none" },
        copyLimits: { eyebrow: 32, headline: 60, subline: 120, cta: 24 },
      });
      // Side-by-side variants only where there is width.
      expect(Object.keys(lifestyle.variants).sort()).toEqual(
        [...CREATIVE_FORMAT_IDS].sort(),
      );
      expect(lifestyle.variants.feed_portrait).toEqual([
        "text_bottom",
        "text_top",
      ]);
      expect(lifestyle.variants.square).toContain("text_side");
      expect(lifestyle.variants.landscape).toContain("text_side");
    });

    it("reports the project's creative settings, or none without a brand kit", async () => {
      const mine = await call("viewer", "GET", "creative/options");
      expect(mine.json().config).toMatchObject({
        maxArtCorrections: 2,
        visualReview: true,
        logoPlacement: "auto",
        ctaStyle: "pill",
      });
      expect(mine.json().config.enabledTemplates).toHaveLength(7);
      const bare = await call("owner", "GET", "creative/options", undefined, {
        project: b,
      });
      expect(bare.statusCode, bare.body).toBe(200);
      expect(bare.json().config).toBeNull();
      expect(bare.json().templates).toHaveLength(7);
    });
  });

  describe("the creative of a post", () => {
    it("is null until one exists and the latest one that is not superseded", async () => {
      const content = await newContent();
      const none = await call(
        "viewer",
        "GET",
        `content/${content.id}/creative`,
      );
      expect(none.statusCode).toBe(200);
      expect(none.json()).toBeNull();
      const older = await produce("editor", content.id);
      const newer = await produce("editor", content.id);
      expect(
        (await call("viewer", "GET", `content/${content.id}/creative`)).json(),
      ).toMatchObject({ id: newer.id });
      // Attaching the newer one and then the older one supersedes the newer.
      expect(
        (await call("editor", "POST", `creatives/${newer.id}/attach`, {}))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("editor", "POST", `creatives/${older.id}/attach`, {}))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("viewer", "GET", `creatives/${newer.id}`)).json().status,
      ).toBe("superseded");
      expect(
        (await call("viewer", "GET", `content/${content.id}/creative`)).json(),
      ).toMatchObject({ id: older.id, status: "attached" });
      // A post that does not exist, or a malformed id.
      for (const id of [randomUUID(), "not-an-id"]) {
        const response = await call("viewer", "GET", `content/${id}/creative`);
        expect(response.statusCode, id).toBe(404);
      }
      expect(
        (await call("viewer", "GET", `creatives/${randomUUID()}`)).statusCode,
      ).toBe(404);
      expect(
        (await call("viewer", "GET", "creatives/not-an-id")).statusCode,
      ).toBe(404);
    });

    it("explicit choices fail loudly for a manual request (R31)", async () => {
      // Lifestyle has no centered layout; the person asked for it by name.
      const response = await call("editor", "POST", "creatives", {
        ...produceBody((await newContent()).id),
        variant: "centered",
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("CREATIVE_VARIANT_NOT_AVAILABLE");
    });
  });

  describe("bodies are strict (R45)", () => {
    it("refuses unknown and malformed fields on every route", async () => {
      const creative = await produce();
      const before = (
        await call("owner", "GET", `creatives/${creative.id}`)
      ).json();
      const content = await newContent();
      const bad: Array<[string, unknown]> = [
        ["creatives", { ...produceBody(content.id), mode: "run" }],
        ["creatives", { ...produceBody(content.id), contentId: "nope" }],
        ["creatives", { ...produceBody(content.id), template: "carousel" }],
        ["creatives", { ...produceBody(content.id), artAssetId: "nope" }],
        [
          "creatives",
          { ...produceBody(content.id), options: { textScale: "xl" } },
        ],
        ["creatives", { ...produceBody(content.id), copy: { eyebrow: "x" } }],
        [
          "creatives",
          { ...produceBody(content.id), copy: { ...COPY, extra: "x" } },
        ],
        [
          "creatives",
          {
            ...produceBody(content.id),
            generateArt: {
              ...CONFIRM,
              confirmPromptMayBeSentToProvider: false,
            },
          },
        ],
        [
          "creatives",
          {
            ...produceBody(content.id),
            generateArt: { ...CONFIRM, requestId: "nope" },
          },
        ],
        [`creatives/${creative.id}/recompose`, { variant: "sideways" }],
        [`creatives/${creative.id}/recompose`, { assetId: randomUUID() }],
        [`creatives/${creative.id}/regenerate-art`, { ...CONFIRM, note: "x" }],
        [
          `creatives/${creative.id}/regenerate-art`,
          { ...CONFIRM, correction: { kind: "more_pixels" } },
        ],
        [
          `creatives/${creative.id}/regenerate-art`,
          { ...CONFIRM, requestId: 7 },
        ],
        [`creatives/${creative.id}/review`, { force: true }],
        [`creatives/${creative.id}/attach`, { mode: "run" }],
        [`creatives/${creative.id}/attach`, { acceptQaFindings: false }],
        [`creatives/${creative.id}/attach`, { acceptQaFindings: "yes" }],
      ];
      for (const [path, payload] of bad) {
        const response = await call("owner", "POST", path, payload);
        expect(response.statusCode, `${path} ${JSON.stringify(payload)}`).toBe(
          400,
        );
        expect(response.json().error.code).toBe("VALIDATION_FAILED");
      }
      // None of them changed anything, attach least of all.
      expect(await creativesOf(a, content.id)).toHaveLength(0);
      const after = await call("owner", "GET", `creatives/${creative.id}`);
      expect(after.json()).toEqual(before);
    });

    it("takes a missing body as an empty one where nothing is asked", async () => {
      const creative = await produce();
      expect(
        (await call("owner", "POST", `creatives/${creative.id}/recompose`))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("owner", "POST", `creatives/${creative.id}/attach`))
          .statusCode,
      ).toBe(200);
    });
  });

  it("carries the ids a refusal names to the client (R56)", async () => {
    const content = await newContent();
    const refused = await call(
      "editor",
      "POST",
      "creatives",
      produceBody(content.id, assets.unapprovedArt),
    );
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: "ASSET_RIGHTS",
      detail: { assetIds: assets.unapprovedArt, reasons: "not_approved" },
    });
    expect(await creativesOf(a, content.id)).toHaveLength(0);
    // An error without detail has none.
    const missing = await call("viewer", "GET", `creatives/${randomUUID()}`);
    expect(missing.json().error).toEqual({
      code: "NOT_FOUND",
      message: "NOT FOUND",
    });
  });

  describe("paid art is retried without paying twice (R51)", () => {
    it("uses the client's request id for new art", async () => {
      const generate = imageProvider();
      const content = await newContent();
      const requestId = randomUUID();
      const body = {
        contentId: content.id,
        template: "lifestyle",
        copy: COPY,
        generateArt: { ...CONFIRM, requestId },
      };
      const first = await call("owner", "POST", "creatives", body);
      expect(first.statusCode, first.body).toBe(201);
      expect(first.json()).toMatchObject({
        status: "needs_rights",
        cost: { settledMicros: IMAGE_MAX, unknownMicros: 0 },
      });
      expect(await reservation(a, requestId)).toMatchObject({
        state: "settled",
      });
      // The same request again: the client did not see the answer.
      const retried = await call("owner", "POST", "creatives", body);
      expect(retried.statusCode, retried.body).toBe(409);
      expect(retried.json().error.code).toBe("RESERVATION_ALREADY_USED");
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await creativesOf(a, content.id)).toHaveLength(1);
    });

    it("uses the client's request id for a regeneration and counts it once", async () => {
      const generate = imageProvider();
      const creative = await produce();
      const requestId = randomUUID();
      const body = { ...CONFIRM, requestId };
      const first = await call(
        "owner",
        "POST",
        `creatives/${creative.id}/regenerate-art`,
        body,
      );
      expect(first.statusCode, first.body).toBe(200);
      expect(await reservation(a, requestId)).toMatchObject({
        state: "settled",
      });
      const paid = first.json();
      expect(paid.cost.settledMicros).toBe(IMAGE_MAX);
      expect(paid.cost.reservationIds).toHaveLength(1);
      expect(
        paid.corrections.filter((c: { kind: string }) => c.kind === "art"),
      ).toEqual([expect.objectContaining({ kind: "art", requestId })]);
      // Two corrections are allowed, so the retry gets as far as the payment.
      const retried = await call(
        "owner",
        "POST",
        `creatives/${creative.id}/regenerate-art`,
        body,
      );
      expect(retried.statusCode, retried.body).toBe(409);
      expect(retried.json().error.code).toBe("RESERVATION_ALREADY_USED");
      expect(generate).toHaveBeenCalledTimes(1);
      const after = (
        await call("owner", "GET", `creatives/${creative.id}`)
      ).json();
      // The creative's cost and attempts are what the one payment made.
      expect(after.cost).toEqual(paid.cost);
      expect(
        after.corrections.filter((c: { kind: string }) => c.kind === "art"),
      ).toHaveLength(1);
      expect(after.version).toBe(paid.version);
    });
  });

  describe("rate limits", () => {
    it("limits paid art and the review to three a minute", async () => {
      const ip = freshIp();
      const unknown = randomUUID();
      for (const [path, payload] of [
        [`creatives/${unknown}/regenerate-art`, CONFIRM],
        [`creatives/${unknown}/review`, {}],
      ] as const) {
        const own = freshIp();
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++)
          statuses.push(
            (await call("owner", "POST", path, payload, { ip: own }))
              .statusCode,
          );
        expect(statuses, path).toEqual([404, 404, 404, 429]);
      }
      // A creative with new art is limited, one without it is not.
      const paid: number[] = [];
      for (let i = 0; i < 4; i++)
        paid.push(
          (
            await call(
              "owner",
              "POST",
              "creatives",
              { generateArt: CONFIRM },
              { ip },
            )
          ).statusCode,
        );
      expect(paid).toEqual([400, 400, 400, 429]);
      const free: number[] = [];
      for (let i = 0; i < 6; i++)
        free.push(
          (await call("owner", "POST", "creatives", {}, { ip })).statusCode,
        );
      expect(free).toEqual([400, 400, 400, 400, 400, 400]);
    });

    // M4: a free creative is an ordinary write: it counts against the
    // client's write limit (100 a minute), not a bucket of its own.
    it("counts a free creative against the client's write limit", async () => {
      const ip = freshIp();
      const unknown = randomUUID();
      for (let i = 0; i < 99; i++)
        expect(
          (
            await call(
              "owner",
              "POST",
              `creatives/${unknown}/recompose`,
              {},
              { ip },
            )
          ).statusCode,
        ).toBe(404);
      const free: number[] = [];
      for (let i = 0; i < 2; i++)
        free.push(
          (await call("owner", "POST", "creatives", {}, { ip })).statusCode,
        );
      expect(free).toEqual([400, 429]);
    });
  });
});
