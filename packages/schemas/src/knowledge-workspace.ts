import { z } from "zod";

export const knowledgeTopic = z.enum([
  "description",
  "audience",
  "platforms",
  "features",
  "limitations",
]);
export const knowledgeStage = z.enum(["documented", "implemented"]);
export const knowledgeEvidence = z
  .object({
    path: z.string().min(1).max(400),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(1).max(4000),
  })
  .strict();
export const knowledgeProposal = z
  .object({
    statement: z.string().min(1).max(1000),
    topic: knowledgeTopic,
    stage: knowledgeStage,
    reason: z.string().min(1).max(1000),
    evidence: knowledgeEvidence,
  })
  .strict();
export const knowledgeAnalysisOutput = z
  .object({ proposals: z.array(knowledgeProposal).max(30) })
  .strict();
export const knowledgeDraftBase = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(""),
    audience: z.string().max(1000).default(""),
    kind: z.enum(["manual", "file", "website", "github"]),
    text: z.string().max(100000).default(""),
    url: z.url().optional(),
    connectionId: z.uuid().optional(),
    repositoryId: z.number().int().positive().optional(),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .optional(),
    branch: z.string().min(1).max(200).optional(),
    paths: z
      .array(z.string().max(400))
      .min(1)
      .max(20)
      .default(["README.md", "docs/"]),
    modelUse: z.boolean().default(false),
    language: z.enum(["de", "en"]).default("de"),
  })
  .strict();
export const knowledgeDraft = knowledgeDraftBase.superRefine((v, ctx) => {
  const require = (ok: unknown, path: string) => {
    if (!ok)
      ctx.addIssue({ code: "custom", message: "REQUIRED", path: [path] });
  };
  if (v.kind === "github") {
    require(v.connectionId, "connectionId");
    require(v.repositoryId, "repositoryId");
    require(v.repository, "repository");
  } else if (v.kind === "website") require(v.url, "url");
  else require(v.text.trim(), "text");
});
export type KnowledgeDraft = z.infer<typeof knowledgeDraft>;
export type KnowledgeProposal = z.infer<typeof knowledgeProposal>;
export type KnowledgeFile = {
  path: string;
  text: string;
  hash: string;
  url?: string;
};
export type KnowledgeSnapshot = {
  commit: string | null;
  files: KnowledgeFile[];
  partial: boolean;
  skipped: number;
  unreadablePaths?: string[];
};
