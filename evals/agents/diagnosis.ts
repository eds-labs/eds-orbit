/**
 * The reasons file of the review eval's diagnostic mode
 * (ORBIT_EVAL_DIAGNOSE=good): per case and round the review's verdict, the
 * model's reasons and revision instructions, and the synthetic draft body,
 * read from what the review step stores on the content
 * (`agentReviewDecision`). It is written only to the gitignored `.runtime/`
 * directory, never to docs/evidence and never to stdout, and never with the
 * key. A diagnostic run is not a gate result.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewMode, VerdictClass } from "./live-plan.ts";

export const DIAGNOSTIC_BANNER =
  "DIAGNOSTIC — not a gate result (never a PASS for Approval J)";
// Relative to the repository root; gitignored.
export const DIAGNOSIS_DIR = ".runtime";

/** One review round of a case, as the review step stored it. */
export type RoundDiagnosis = {
  round: 1 | 2;
  // The review's verdict for this draft (`revise`, `approve`, `reject`, `needs_owner`).
  verdict: string;
  // The model's answer; null when the deterministic checks decided.
  modelVerdict: string | null;
  reasons: string[];
  revisionInstructions: string | null;
  deterministicProblems: string[];
  // Synthetic eval text of the draft this round judged.
  body: string;
};

export type CaseDiagnosis = {
  caseId: string;
  label: "good" | "bad";
  category: string;
  // The case's final verdict class, as in the metrics report.
  verdict: VerdictClass;
  errorCode: string | null;
  rounds: RoundDiagnosis[];
};

export type DiagnosisFile = {
  note: string;
  result: "DIAGNOSTIC";
  mode: ReviewMode;
  datasetVersion: string;
  datasetHash: string;
  startedAt: string;
  commit: string | null;
  dirty: boolean | null;
  promptHash: string;
  stoppedReason: string | null;
  cleanupError: string | null;
  cases: CaseDiagnosis[];
};

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => "> " + line)
    .join("\n");

export function renderDiagnosis(
  file: Omit<DiagnosisFile, "note" | "result">,
): string {
  return [
    "# Agent review eval diagnosis",
    "",
    `**${DIAGNOSTIC_BANNER}**`,
    "",
    "Synthetic eval texts only. Local file under .runtime/; do not commit or share it as evidence.",
    "",
    `- Mode: ${file.mode}`,
    `- Dataset: ${file.datasetVersion}`,
    `- Dataset hash: \`${file.datasetHash}\``,
    `- Started: ${file.startedAt}`,
    `- Commit: ${file.commit ?? "unknown"}${file.dirty ? " (tracked files changed)" : file.dirty === null ? " (state unknown)" : ""}`,
    `- Review prompt and schema hash: \`${file.promptHash}\``,
    `- Stopped early: ${file.stoppedReason ?? "no"}`,
    ...(file.cleanupError ? [`- Cleanup failed: ${file.cleanupError}`] : []),
    "",
    ...file.cases.flatMap((c) => [
      `## ${c.caseId}`,
      "",
      `- Label: ${c.label} (${c.category})`,
      `- Final verdict: ${c.verdict}${c.errorCode ? ` (${c.errorCode})` : ""}`,
      "",
      ...c.rounds.flatMap((r) => [
        `### Round ${r.round}: ${r.verdict}`,
        "",
        `- Model verdict: ${r.modelVerdict ?? "none (deterministic checks)"}`,
        `- Deterministic problems: ${r.deterministicProblems.join(", ") || "none"}`,
        "- Reasons:",
        ...(r.reasons.length
          ? r.reasons.map((reason) => `  - ${reason}`)
          : ["  - none"]),
        `- Revision instructions: ${r.revisionInstructions ?? "none"}`,
        "- Draft:",
        "",
        quote(r.body),
        "",
      ]),
    ]),
  ].join("\n");
}

/**
 * Writes `<root>/.runtime/agent-review-diagnosis-<stamp>.json` and `.md`
 * (owner-only) and returns their paths. Refuses to write anything that
 * contains the run's key (EVAL_DIAGNOSIS_SECRET).
 */
export async function writeDiagnosis(
  root: string,
  stamp: string,
  content: Omit<DiagnosisFile, "note" | "result">,
  secret: string,
): Promise<{ json: string; md: string }> {
  if (!secret) throw new Error("EVAL_DIAGNOSIS_SECRET_REQUIRED");
  if (!/^[0-9TZ-]+$/.test(stamp))
    throw new Error("EVAL_DIAGNOSIS_STAMP_INVALID");
  const file: DiagnosisFile = {
    note: DIAGNOSTIC_BANNER + ". Synthetic eval texts only; local file.",
    result: "DIAGNOSTIC",
    ...content,
  };
  const json = JSON.stringify(file, null, 2) + "\n";
  const md = renderDiagnosis(content);
  if (json.includes(secret) || md.includes(secret))
    throw new Error("EVAL_DIAGNOSIS_SECRET");
  const dir = join(root, DIAGNOSIS_DIR);
  await mkdir(dir, { recursive: true });
  const base = join(dir, `agent-review-diagnosis-${stamp}`);
  await writeFile(base + ".json", json, { mode: 0o600 });
  await writeFile(base + ".md", md, { mode: 0o600 });
  return { json: base + ".json", md: base + ".md" };
}
