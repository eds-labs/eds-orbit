import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { generateImage } from "../../../packages/ai/src/index.ts";
import { sha256Hex } from "../../../packages/creative/src/index.ts";
import {
  demoBrand,
  fixtureArt,
} from "../../../packages/creative/fixtures/demo-brands.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { decideActionRequest } from "../src/modules/action-requests.ts";
import {
  CREATIVE_PREVIEWS,
  runCreativePreview,
} from "../src/modules/marketing/creative/preview.ts";
import {
  authorizeMcpCall,
  visibleMcpTools,
} from "../src/platform/mcp/visibility.ts";
import type { McpPrincipal } from "../src/platform/mcp/principal.ts";
import { moduleScope } from "../src/platform/tenancy/module-roles.ts";
import { create, data, entity } from "../src/shared.ts";
import { renditionComponentsHold } from "../src/modules/marketing/policy/rendition-rights.ts";
import { lumoraProfile } from "./support/creative-profile.ts";
import { createPackageProject, IMAGE_MAX } from "./support/package-project.ts";

// Internal creative previews over MCP: the options name the configured
// primary logo and formats; a proposal waits for the owner's approval, runs
// once in a worker job with at most one paid image (a synthetic provider
// here), and its result carries the composed image, never a publication.

vi.mock("../../../packages/ai/src/index.ts", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  respond: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImage: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
  generateImageWithReferences: vi.fn(async () => {
    throw new Error("REAL_PROVIDER_CALLED");
  }),
}));

// sharp is the creative package's dependency, not the API's.
const sharp = createRequire(
  new URL("../../../packages/creative/package.json", import.meta.url),
)("sharp") as (bytes: Buffer) => {
  metadata(): Promise<{ format?: string; width?: number; height?: number }>;
};
const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
const OPTIONS = "marketing_creative_options";
const CREATE = "marketing_creative_preview_create";
const STATUS = "marketing_creative_preview_status";
const RESULT = "marketing_creative_preview_result";
const COPY = {
  eyebrow: "New this autumn",
  headline: "Evenings feel softer in warm light",
  subline: "Lamps and throws for a calm room.",
  cta: "Shop the collection",
};

describe.skipIf(!enabled)("Creative previews over MCP", () => {
  type Project = Awaited<ReturnType<typeof createPackageProject>>;
  let a: Project, b: Project;
  let ownerA: McpPrincipal, editorA: McpPrincipal, ownerB: McpPrincipal;
  let artPng: Buffer;
  const logos = {} as Record<"a" | "b", string>;
  let photoB = "";
  const saved: Record<string, string | undefined> = {};
  const flags = {
    ORBIT_CREATIVE_STUDIO: "true",
    ORBIT_MCP_PROPOSALS: "true",
    ORBIT_MCP_TASKS: "false",
  };
  const image = vi.mocked(generateImage);

  const runIn = <T>(p: Project, work: (tx: DbTx) => Promise<T>) =>
    scoped(p.owner.workspaceId, p.owner.projectId, work);
  const addAsset = (p: Project, type: string, bytes: Buffer) =>
    runIn(p, async (tx) => {
      const row = await create(tx, p.owner, "assets", {
        name: `Synthetic ${type}`,
        type,
        mime: "image/png",
        base64: bytes.toString("base64"),
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        source: "Synthetic fixture",
        license: "Synthetic rights fixture",
        validUses: ["brand", "social"],
        usageApproved: true,
        assetStatus: "approved",
        providerUse: false,
        driveSyncStatus: "LOCAL_ONLY",
      });
      return row.id;
    });
  const saveProfile = (p: Project, logoAssetId: string) =>
    runIn(p, (tx) =>
      tx.projectMarketingProfile.updateMany({
        where: { projectId: p.owner.projectId },
        data: {
          data: lumoraProfile({ logoAssetId }) as any,
          version: { increment: 1 },
        },
      }),
    );
  async function principal(scope: Scope) {
    const scopes = ["orbit:read", "orbit:propose"];
    const g = await authDb.mcpGrant.create({
      data: {
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        clientId: `https://preview.test/${randomUUID()}.json`,
        projectIds: [scope.projectId],
        modules: [],
        scopes,
        status: "active",
        activatedAt: new Date(),
      },
    });
    return {
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      clientId: g.clientId,
      grantId: g.id,
      projectIds: [scope.projectId],
      modules: [],
      scopes: new Set(scopes),
    } as McpPrincipal;
  }
  async function call(
    by: McpPrincipal,
    name: string,
    projectId: string,
    args: object = {},
  ): Promise<{ output: any; images?: any[] }> {
    const { tool, scope } = await authorizeMcpCall(by, name, projectId);
    const result = await tool.execute(
      {
        scope: moduleScope(scope, "marketing"),
        runId: "synthetic-preview",
        conversationId: "synthetic-preview",
        callIndex: 0,
        channel: {
          kind: "mcp",
          clientId: by.clientId,
          grantId: by.grantId,
          requestId: randomUUID(),
        },
      },
      args,
    );
    expect(tool.outputSchema!.safeParse(result.output).success).toBe(true);
    return result;
  }
  const request = (extra: object = {}) => ({
    channel: "instagram",
    title: "Autumn evenings",
    postText: "Evenings feel softer in warm light. Find lamps and throws.",
    copy: COPY,
    template: "lifestyle",
    art: "generate",
    artDirection: { motif: "A reading lamp glowing over a wool throw" },
    maxBudgetMicros: 1_000_000,
    idempotencyKey: randomUUID(),
    ...extra,
  });
  const decide = (p: Project, id: string) =>
    runIn(p, async (tx) => {
      const row = await entity(tx, p.owner, "action_requests", id);
      return decideActionRequest(tx, p.owner, id, {
        version: row.version,
        packageHash: data(row).packageHash,
        decision: "approve",
      });
    });
  const counts = (p: Project) =>
    runIn(p, async (tx) =>
      Object.fromEntries(
        await Promise.all(
          [
            "publications",
            "postiz_drafts",
            "content",
            "missions",
            "assignments",
            "content_packages",
          ].map(async (kind) => [
            kind,
            await tx.entity.count({
              where: { projectId: p.owner.projectId, kind },
            }),
          ]),
        ),
      ),
    );
  /** Proposes, approves and runs a preview; returns its id. */
  async function made(p: Project, by: McpPrincipal, args: object) {
    const proposed = (await call(by, CREATE, p.owner.projectId, args)).output;
    await decide(p, proposed.actionRequestId);
    const status = (
      await call(by, STATUS, p.owner.projectId, {
        actionRequestId: proposed.actionRequestId,
      })
    ).output.result;
    await runCreativePreview(p.owner, status.previewId);
    return status.previewId as string;
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries(flags)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    a = await createPackageProject({ name: "Synthetic preview A" });
    b = await createPackageProject({ name: "Synthetic preview B" });
    const lumora = await demoBrand("lumora");
    const kestrel = await demoBrand("kestrel");
    artPng = (await fixtureArt("good", "lumora")).bytes;
    logos.a = await addAsset(a, "logo", lumora.logos[0]!.bytes);
    logos.b = await addAsset(b, "logo", kestrel.logos[0]!.bytes);
    photoB = await addAsset(b, "photo", artPng);
    await saveProfile(a, logos.a);
    await saveProfile(b, logos.b);
    ownerA = await principal(a.owner);
    editorA = await principal(a.editor);
    ownerB = await principal(b.owner);
    image.mockImplementation((async (
      req: Parameters<typeof generateImage>[0],
    ) => ({
      bytes: artPng,
      model: "gpt-image-2.5-flare",
      size: req.size,
      quality: req.quality,
      background: req.background,
      usage: null,
    })) as never);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeDatabase();
  });

  it("lists the tools only while the Creative Studio is on", async () => {
    const names = async () =>
      (await visibleMcpTools(ownerA, a.owner.projectId)).map((t) => t.name);
    expect(await names()).toEqual(
      expect.arrayContaining([OPTIONS, CREATE, STATUS, RESULT]),
    );
    process.env.ORBIT_CREATIVE_STUDIO = "false";
    try {
      const off = await names();
      for (const name of [OPTIONS, CREATE, STATUS, RESULT])
        expect(off).not.toContain(name);
    } finally {
      process.env.ORBIT_CREATIVE_STUDIO = "true";
    }
  });

  it("names the configured primary logo and the channel formats", async () => {
    const options = (await call(ownerA, OPTIONS, a.owner.projectId)).output
      .result;
    expect(options.brandKit).toMatchObject({
      ready: true,
      problem: null,
      primaryLogo: { assetId: logos.a, usable: true },
    });
    expect(options.formatsByChannel.instagram).toEqual(["feed_portrait"]);
    expect(options.formats).toContainEqual({
      id: "feed_portrait",
      width: 1080,
      height: 1350,
    });
    expect(options.image).toMatchObject({
      configured: true,
      maxCostMicrosPerImage: IMAGE_MAX,
    });
  });

  it("makes one Instagram 4:5 preview after the owner's approval and never publishes", async () => {
    const before = await counts(a);
    const args = request();
    const proposed = (await call(ownerA, CREATE, a.owner.projectId, args))
      .output;
    expect(proposed).toMatchObject({
      status: "pending",
      requiresApproval: true,
      deduplicated: false,
    });
    // Nothing runs before the approval.
    expect(
      (
        await call(ownerA, STATUS, a.owner.projectId, {
          actionRequestId: proposed.actionRequestId,
        })
      ).output.result,
    ).toMatchObject({ status: "awaiting_approval", previewId: null });
    expect(
      await runIn(a, (tx) =>
        tx.entity.count({ where: { kind: CREATIVE_PREVIEWS } }),
      ),
    ).toBe(0);
    // A retry with the same key is the same proposal.
    expect(
      (await call(ownerA, CREATE, a.owner.projectId, args)).output,
    ).toMatchObject({
      actionRequestId: proposed.actionRequestId,
      deduplicated: true,
    });

    await decide(a, proposed.actionRequestId);
    const queued = (
      await call(ownerA, STATUS, a.owner.projectId, {
        actionRequestId: proposed.actionRequestId,
      })
    ).output.result;
    expect(queued).toMatchObject({ status: "queued", progress: 0 });
    const job = await runIn(a, (tx) =>
      tx.entity.findFirst({
        where: {
          kind: "jobs",
          data: { path: ["resourceId"], equals: queued.previewId },
        },
      }),
    );
    expect(data(job)).toMatchObject({
      topic: "creative_preview",
      maxAttempts: 1,
    });

    image.mockClear();
    await runCreativePreview(a.owner, queued.previewId);
    // A second run of the same job changes nothing and pays nothing.
    await runCreativePreview(a.owner, queued.previewId);
    expect(image).toHaveBeenCalledTimes(1);

    const result = await call(ownerA, RESULT, a.owner.projectId, {
      previewId: queued.previewId,
    });
    const r = result.output.result;
    expect(r).toMatchObject({
      status: "completed",
      progress: 100,
      published: false,
      channel: "instagram",
      postText: args.postText,
      copy: { headline: COPY.headline, cta: COPY.cta },
      image: {
        format: "feed_portrait",
        width: 1080,
        height: 1350,
        aspectRatio: "1080:1350",
        mimeType: "image/png",
      },
      brandKit: { logoAssetId: logos.a },
      rights: { status: "awaiting_owner_rights_decision" },
      approval: { generation: "approved", publishing: "not_requested" },
      cost: { settledMicros: IMAGE_MAX, unknownMicros: 0 },
      creative: { template: "lifestyle" },
    });
    expect(r.rights.pendingAssetIds).toEqual([r.artAssetId]);
    expect(r.qa.checks.map((c: any) => c.code)).toContain("LOGO_INTEGRITY");
    expect(r.image.orbitUrl).toContain(`/assets/${r.image.assetId}/content`);
    // The image travels as MCP image content: a small JPEG of the rendition.
    expect(result.images).toHaveLength(1);
    const jpeg = Buffer.from(result.images![0].data, "base64");
    expect(result.images![0].mimeType).toBe("image/jpeg");
    const meta = await sharp(jpeg).metadata();
    expect(meta).toMatchObject({ format: "jpeg", width: 576, height: 720 });
    // The rendition is a reference that can never be a post's image.
    const rendition = await runIn(a, (tx) =>
      entity(tx, a.owner, "assets", r.image.assetId),
    );
    expect(data(rendition)).toMatchObject({
      usageApproved: false,
      assetStatus: "reference",
      boundTo: { previewId: queued.previewId },
    });
    expect(
      await runIn(a, (tx) =>
        renditionComponentsHold(tx, a.owner, data(rendition)),
      ),
    ).toBe(false);
    // No post, mission, assignment, package, publication or Postiz draft.
    expect(await counts(a)).toEqual(before);
  });

  it("refuses a limit below the image ceiling and new art from an editor", async () => {
    await expect(
      call(ownerA, CREATE, a.owner.projectId, request({ maxBudgetMicros: 10 })),
    ).rejects.toMatchObject({ code: "PREVIEW_BUDGET_TOO_LOW" });
    await expect(
      call(editorA, CREATE, a.owner.projectId, request()),
    ).rejects.toMatchObject({ code: "OWNER_REQUIRED" });
  });

  it("keeps each project's brand kit and assets to itself", async () => {
    // Project A cannot draw project B's photo.
    await expect(
      call(
        ownerA,
        CREATE,
        a.owner.projectId,
        request({ art: "asset", artAssetId: photoB, artDirection: undefined }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Project B's free preview from its own photo draws B's logo.
    const previewB = await made(
      b,
      ownerB,
      request({ art: "asset", artAssetId: photoB, artDirection: undefined }),
    );
    const r = (
      await call(ownerB, RESULT, b.owner.projectId, { previewId: previewB })
    ).output.result;
    expect(r).toMatchObject({
      status: "completed",
      brandKit: { logoAssetId: logos.b },
      artAssetId: photoB,
      cost: { settledMicros: 0 },
      rights: { status: "approved_components" },
    });
    // Neither project reads the other's preview.
    await expect(
      call(ownerA, RESULT, a.owner.projectId, { previewId: previewB }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      authorizeMcpCall(ownerA, RESULT, b.owner.projectId),
    ).rejects.toBeTruthy();
  });

  it("records a refusal on the preview without paying", async () => {
    const previewId = await made(
      a,
      ownerA,
      request({
        copy: { ...COPY, headline: "x".repeat(400) },
        art: "none",
        template: "tips",
        artDirection: undefined,
      }),
    ).catch((error) => error);
    // An over-long headline is refused when it is proposed.
    expect(previewId).toMatchObject({ code: "CREATIVE_TEXT_TOO_LONG" });
  });
});
