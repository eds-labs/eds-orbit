import { z } from "zod";
import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";
import { defineTool, type ToolContext } from "../../platform/agents/tools/registry.ts";
import { CMS_SCOPE } from "../../platform/mcp/scopes.ts";
import { mcpApproveUrl, mcpProposalOrigin, mcpRequester } from "../../platform/mcp/proposals.ts";
import { assertModuleEnabledFor } from "../../platform/modules/enforcement.ts";
import { modelParameters, readOperation, serviceArgs } from "../../platform/tasks/operation-tools.ts";
import { userScoped } from "../../platform/tenancy/scope.ts";
import { authorize } from "../../platform/tenancy/permissions.ts";
import type { RequestedBy } from "../action-requests.ts";
import { data, DomainError, hash } from "../../shared.ts";
import { entryStatus } from "./contract.ts";
import { getEntry, insertEntry, listEntries, saveDraft, sitesOf } from "./entries/entries.ts";
import { requireCms } from "./gate.ts";
import { importAsset, listAssets } from "./media/assets.ts";
import { CMS_COMPOSE, CMS_PUBLISH_REQUEST, CMS_READ } from "./permissions.ts";
import { requestPublication } from "./publishing/approval.ts";
import { preflight } from "./publishing/preflight.ts";
import { pendingRequestFor } from "./publishing/requests.ts";
import { listSites } from "./sites/sites.ts";

// The content module's assistant and MCP tools (ADR 0029 §6, CH1.16). Every
// tool needs the module on, the member's permission and, over MCP, the
// content scope `orbit:cms`. Reads (R0) list sites, entries, media and
// publication status. Draft writes and media imports are internal (W0, MCP
// with `orbit:write`): nothing becomes public. A publication is only ever
// proposed (P_proposal): it becomes the content module's own approval
// request (`cms.entry.publish`), which the owner or a content editor decides
// in Orbit (decision E-4); no mandate covers it.

const shared = { module: "cms", feature: "cms" as const, mcpScopes: [CMS_SCOPE] };
// A UUID with a short pattern keeps tool schemas small for the model.
const id = z.string().regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/);
const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);

async function guard(scope: Scope, permission: PermissionDef) {
  authorize(scope, permission);
  await assertModuleEnabledFor(scope, "cms");
  await scoped(scope.workspaceId, scope.projectId, (tx) => requireCms(tx, scope));
}

/**
 * Plain text to orbit-doc: blank lines separate paragraphs, `## ` and `### `
 * start headings, lines starting with `- ` form a list. For clients that do
 * not build orbit-doc JSON themselves.
 */
export function textToDoc(text: string) {
  const blocks: object[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const part = chunk.trim();
    if (!part) continue;
    const heading = /^(#{2,4})\s+(.+)$/.exec(part);
    if (heading && !part.includes("\n")) {
      blocks.push({ type: "heading", level: heading[1]!.length, content: [{ text: heading[2]!.trim() }] });
      continue;
    }
    const lines = part.split("\n");
    if (lines.every((line) => /^[-*]\s+/.test(line.trim())))
      blocks.push({
        type: "list",
        ordered: false,
        items: lines.map((line) => [{ type: "paragraph", content: [{ text: line.trim().replace(/^[-*]\s+/, "") }] }]),
      });
    else blocks.push({ type: "paragraph", content: [{ text: lines.map((l) => l.trim()).join(" ") }] });
  }
  return { schema: "orbit-doc", version: 1, blocks };
}

const bodyOf = (args: { body?: unknown; text?: string }) => {
  if (args.body !== undefined && args.text !== undefined) throw new DomainError("CMS_BODY_AMBIGUOUS", 422);
  return args.text !== undefined ? textToDoc(args.text) : args.body;
};

// ----------------------------------------------------------------- reads

export const cmsSitesTool = readOperation({
  ...shared,
  name: "cms_sites",
  description: "The project's websites for content: id, name, address, languages, routes and verification state.",
  input: z.object({}).strict(),
  permission: CMS_READ,
  async run(tx, scope) {
    const { items } = await listSites(tx, scope, {});
    return {
      items: items.map((s) => ({
        siteId: s.id,
        name: s.name,
        baseUrl: s.baseUrl,
        locales: s.locales,
        defaultLocale: s.defaultLocale,
        routes: s.routes,
        verification: s.verification,
        contentRules: s.contentRules,
      })),
    };
  },
});

export const cmsEntriesTool = readOperation({
  ...shared,
  name: "cms_entries",
  description:
    "Content entries (articles) with status (draft, scheduled, published, archived), language, title and whether a publication request is open. Filter by type, locale, status (comma-separated), siteId or q (title); cursor pages.",
  input: z
    .object({
      type: z.string().max(31).optional(),
      locale: locale.optional(),
      status: z.string().max(80).optional(),
      siteId: id.optional(),
      q: z.string().trim().min(1).max(100).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.int().min(1).max(50).optional(),
    })
    .strict(),
  permission: CMS_READ,
  async run(tx, scope, args) {
    return listEntries(tx, scope, { ...args, ...(args.limit ? { limit: args.limit } : {}) });
  },
});

export const cmsEntryGetTool = readOperation({
  ...shared,
  name: "cms_entry_get",
  description:
    "One entry: its draft (title, excerpt, body as orbit-doc, SEO, fields, images, terms, authors, version), the live revision, the sites, live URLs, an open request and what would stop its publication (preflight issues).",
  input: z.object({ entryId: id }).strict(),
  permission: CMS_READ,
  async run(tx, scope, args) {
    const entry = await getEntry(tx, scope, args.entryId);
    const [status] = await entryStatus(tx, scope, [args.entryId]);
    const row = await tx.cmsEntry.findFirstOrThrow({ where: { id: args.entryId, projectId: scope.projectId } });
    const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: row.id, projectId: scope.projectId } });
    const issues = await preflight(tx, scope, row, { ...draft, slug: row.slug }, await sitesOf(tx, scope, row.id));
    return { ...entry, urls: status?.urls ?? [], preflight: { ok: issues.length === 0, issues } };
  },
});

export const cmsPublicationStatusTool = readOperation({
  ...shared,
  name: "cms_publication_status",
  description: "Status of up to 20 entries: live state, live revision, scheduled time, open request and live URLs per site.",
  input: z.object({ entryIds: z.array(id).min(1).max(20) }).strict(),
  permission: CMS_READ,
  async run(tx, scope, args) {
    const items = await entryStatus(tx, scope, args.entryIds);
    return { items, missing: args.entryIds.filter((e: string) => !items.some((i) => i.entryId === e)) };
  },
});

export const cmsMediaListTool = readOperation({
  ...shared,
  name: "cms_media",
  description: "Images of the content media library: assetId, size, alt text per language and AI label state. q searches names.",
  input: z.object({ q: z.string().trim().min(1).max(100).optional(), cursor: z.string().max(200).optional() }).strict(),
  permission: CMS_READ,
  async run(tx, scope, args) {
    return listAssets(tx, scope, args);
  },
});

// ---------------------------------------------------------- draft writes

const writeShape = { entryId: z.string(), draftVersion: z.number(), deduplicated: z.boolean() };
const draftOutput = z.object(writeShape).strict();
const draftContent = {
  title: z.string().trim().min(1).max(200).optional(),
  excerpt: z.string().max(500).optional(),
  /** orbit-doc-v1 JSON; or `text` below. */
  body: z.unknown().optional(),
  /** Plain text with blank lines, `## ` headings and `- ` lists, converted to orbit-doc. */
  text: z.string().max(100_000).optional(),
  seo: z.unknown().optional(),
  fields: z.unknown().optional(),
  heroAssetId: id.nullable().optional(),
  termIds: z.array(id).max(50).optional(),
  authorIds: z.array(id).max(10).optional(),
};

const createInput = z
  .object({
    type: z.string().max(31).optional(),
    locale,
    siteIds: z.array(id).max(20).optional(),
    ...draftContent,
    title: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().min(8).max(128),
  })
  .strict();

const clientOf = (ctx: ToolContext) => (ctx.channel?.kind === "mcp" ? ctx.channel.clientId : "assistant");

export const cmsDraftCreateTool = defineTool({
  name: "cms_draft_create",
  namespace: "cms",
  description:
    "Create a content entry (article) as a draft in one language, optionally assigned to sites. Give the body as orbit-doc JSON (body) or plain text (text). Nothing is published; use cms_publish_propose. Retry with the same idempotencyKey returns the same entry.",
  parameters: modelParameters(createInput),
  risk: "W0_internal",
  permission: CMS_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: draftOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(createInput, raw) as z.infer<typeof createInput>;
    await guard(ctx.scope, CMS_COMPOSE);
    const { idempotencyKey, ...rest } = args;
    const argsHash = hash(rest);
    const result = await userScoped(ctx.scope, async (tx) => {
      // A retry finds the entry it made: same member, client and key.
      const earlier = await tx.cmsEntry.findFirst({
        where: {
          projectId: ctx.scope.projectId,
          createdBy: ctx.scope.userId,
          AND: [
            { originRef: { path: ["tool"], equals: "cms_draft_create" } },
            { originRef: { path: ["clientId"], equals: clientOf(ctx) } },
            { originRef: { path: ["idempotencyKey"], equals: idempotencyKey } },
          ],
        },
      });
      if (earlier) {
        if ((earlier.originRef as { argsHash?: string } | null)?.argsHash !== argsHash) throw new DomainError("IDEMPOTENCY_KEY_REUSED", 409);
        const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: earlier.id, projectId: ctx.scope.projectId } });
        return { entryId: earlier.id, draftVersion: draft.version, deduplicated: true };
      }
      const entry = await insertEntry(tx, ctx.scope, {
        type: rest.type ?? "article",
        locale: rest.locale,
        title: rest.title,
        siteIds: rest.siteIds,
        origin: "mcp",
        originRef: { tool: "cms_draft_create", clientId: clientOf(ctx), idempotencyKey, argsHash },
        draft: {
          title: rest.title,
          excerpt: rest.excerpt,
          body: bodyOf(rest),
          seo: rest.seo,
          fields: rest.fields,
          heroAssetId: rest.heroAssetId ?? null,
          termIds: rest.termIds,
          authorIds: rest.authorIds,
        },
      });
      const draft = await tx.cmsDraft.findFirstOrThrow({ where: { entryId: entry.id, projectId: ctx.scope.projectId } });
      return { entryId: entry.id, draftVersion: draft.version, deduplicated: false };
    });
    return { output: draftOutput.parse(result), cards: [] };
  },
});

const updateInput = z.object({ entryId: id, version: z.int().min(1), ...draftContent }).strict();

export const cmsDraftUpdateTool = defineTool({
  name: "cms_draft_update",
  namespace: "cms",
  description:
    "Change an entry's draft with the draft version read (cms_entry_get); only given fields change. The live article stays as it is until a publication is approved.",
  parameters: modelParameters(updateInput),
  risk: "W0_internal",
  permission: CMS_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: draftOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(updateInput, raw) as z.infer<typeof updateInput>;
    await guard(ctx.scope, CMS_COMPOSE);
    const { entryId, version, text, body, ...rest } = args;
    const doc = bodyOf({ body, text });
    const result = await userScoped(ctx.scope, (tx) =>
      saveDraft(tx, ctx.scope, entryId, {
        version,
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
        ...(doc !== undefined ? { body: doc } : {}),
      }),
    );
    return { output: draftOutput.parse({ entryId, draftVersion: result.draft.version, deduplicated: false }), cards: [] };
  },
});

const importInput = z
  .object({
    source: z.enum(["drive", "orbit_file"]),
    driveFileId: z.string().trim().min(10).max(100).optional(),
    fileId: id.optional(),
    name: z.string().trim().min(1).max(200).optional(),
    alt: z.array(z.object({ locale, text: z.string().trim().min(1).max(500) }).strict()).max(10).optional(),
  })
  .strict();
const mediaOutput = z.object({ assetId: z.string(), width: z.number(), height: z.number(), duplicate: z.boolean() }).strict();

export const cmsMediaImportTool = defineTool({
  name: "cms_media_import",
  namespace: "cms",
  description:
    "Import an image (PNG, JPEG, WebP) into the content media library from the project's Google Drive folder (source=drive, driveFileId) or an Orbit file (source=orbit_file, fileId), with alt text per language. Identical images return the existing assetId.",
  parameters: modelParameters(importInput),
  risk: "W0_internal",
  permission: CMS_COMPOSE,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  openWorld: true,
  deferLoading: true,
  exposure: { assistant: false, mcp: true },
  outputSchema: mediaOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(importInput, raw) as z.infer<typeof importInput>;
    await guard(ctx.scope, CMS_COMPOSE);
    const { alt, ...rest } = args;
    const imported = await importAsset(ctx.scope, {
      ...rest,
      ...(alt?.length ? { alt: Object.fromEntries(alt.map((a) => [a.locale, a.text])) } : {}),
    });
    return {
      output: mediaOutput.parse({ assetId: imported.asset.id, width: imported.asset.width, height: imported.asset.height, duplicate: imported.duplicate }),
      cards: [],
    };
  },
});

// -------------------------------------------------------------- proposal

const PROPOSE_NAME = "cms_publish_propose";
const proposeInput = z
  .object({
    entryId: id,
    /** The draft version read; a revision of exactly that draft is proposed. */
    draftVersion: z.int().min(1).optional(),
    changeNote: z.string().max(300).optional(),
    /** ISO time, or local YYYY-MM-DDTHH:MM with an optional IANA timeZone; none: right after approval. */
    at: z.string().max(40).optional(),
    local: z.string().max(16).optional(),
    timeZone: z.string().max(64).optional(),
  })
  .strict();
const proposeOutput = z
  .object({
    status: z.literal("pending_approval"),
    actionRequestId: z.string(),
    deduplicated: z.boolean(),
    expiresAt: z.string(),
    approveUrl: z.string(),
  })
  .strict();

export const cmsPublishProposeTool = defineTool({
  name: PROPOSE_NAME,
  namespace: "cms",
  description:
    "Propose to publish (or update, or schedule at `at`/`local`) an entry's current draft on its sites. The owner or a content editor decides in Orbit; nothing is public before. Check cms_entry_get's preflight first.",
  parameters: modelParameters(proposeInput),
  risk: "P_proposal",
  permission: CMS_PUBLISH_REQUEST,
  feature: shared.feature,
  mcpScopes: shared.mcpScopes,
  mcpProjectRequired: true,
  deferLoading: true,
  exposure: { assistant: true, mcp: true },
  outputSchema: proposeOutput,
  async execute(ctx, raw) {
    const args = serviceArgs(proposeInput, raw) as z.infer<typeof proposeInput>;
    await guard(ctx.scope, CMS_PUBLISH_REQUEST);
    // The requester comes from the call's channel (D-M5-8); the assistant asks as an agent.
    const requester: RequestedBy = ctx.channel
      ? mcpRequester(mcpProposalOrigin(ctx, PROPOSE_NAME), ctx.scope.projectId, args)
      : { kind: "agent", userId: ctx.scope.userId, agentRunId: ctx.runId };
    const output = await userScoped(ctx.scope, async (tx) => {
      const pending = await pendingRequestFor(tx, ctx.scope, args.entryId);
      if (pending) {
        const row = await tx.entity.findFirstOrThrow({ where: { id: pending.id, projectId: ctx.scope.projectId } });
        const stored = data(row).requestedBy as { argsHash?: string } | undefined;
        if (requester.kind === "mcp" && stored?.argsHash === requester.argsHash)
          return { status: "pending_approval" as const, actionRequestId: pending.id, deduplicated: true, expiresAt: pending.expiresAt, approveUrl: mcpApproveUrl(ctx.scope.projectId) };
        throw new DomainError("CMS_REQUEST_PENDING", 409);
      }
      const { entryId, ...input } = args;
      const result = await requestPublication(tx, ctx.scope, entryId, input, requester);
      const row = await tx.entity.findFirstOrThrow({ where: { id: result.requestId!, projectId: ctx.scope.projectId } });
      return {
        status: "pending_approval" as const,
        actionRequestId: result.requestId!,
        deduplicated: false,
        expiresAt: String(data(row).expiresAt),
        approveUrl: mcpApproveUrl(ctx.scope.projectId),
      };
    });
    return { output: proposeOutput.parse(output), cards: [] };
  },
});

export const cmsTools = [
  cmsSitesTool,
  cmsEntriesTool,
  cmsEntryGetTool,
  cmsPublicationStatusTool,
  cmsMediaListTool,
  cmsDraftCreateTool,
  cmsDraftUpdateTool,
  cmsMediaImportTool,
  cmsPublishProposeTool,
];

export const cmsInstructions = [
  "Content (module cms): articles for the project's websites. Read sites with cms_sites, entries with cms_entries and one entry with cms_entry_get (its preflight says what blocks publication). Over MCP, drafts are created with cms_draft_create and changed with cms_draft_update (orbit-doc JSON or plain text), images come in with cms_media_import and need alt text in the article's language.",
  "Publishing is only ever proposed with cms_publish_propose; the owner or a content editor decides in Orbit. Never say an article is live unless cms_publication_status shows it published with a URL.",
];
