import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_BANNER,
  renderDiagnosis,
  writeDiagnosis,
  type DiagnosisFile,
} from "./diagnosis.ts";

// Offline and DB-free: the reasons file of the diagnostic mode.
const SYNTHETIC_KEY = "synthetic-eval-key-not-real-0123456789";
const file = (reason: string): Omit<DiagnosisFile, "note" | "result"> => ({
  mode: "diagnose-good",
  datasetVersion: "agents-review-v2",
  datasetHash: "a".repeat(64),
  startedAt: "2026-10-10T07:00:00.000Z",
  commit: null,
  dirty: null,
  promptHash: "b".repeat(64),
  stoppedReason: null,
  cleanupError: null,
  cases: [
    {
      caseId: "good-needs",
      label: "good",
      category: "good",
      verdict: "reject",
      errorCode: null,
      rounds: [
        {
          round: 1,
          verdict: "revise",
          modelVerdict: "revise",
          reasons: [reason],
          revisionInstructions: "Synthetic | instruction.",
          deterministicProblems: [],
          body: "Synthetic body.",
        },
      ],
    },
  ],
});

describe("Review eval diagnosis file", () => {
  it("renders the banner, every round's reasons, instructions and body", () => {
    const markdown = renderDiagnosis(file("Synthetic reason."));
    expect(DIAGNOSTIC_BANNER).toContain("DIAGNOSTIC — not a gate result");
    expect(markdown).toContain(DIAGNOSTIC_BANNER);
    expect(markdown).toContain("good-needs");
    expect(markdown).toContain("Round 1");
    expect(markdown).toContain("Synthetic reason.");
    expect(markdown).toContain("Synthetic | instruction.");
    expect(markdown).toContain("Synthetic body.");
    expect(markdown).not.toContain("Result: PASS");
    expect(markdown).not.toContain("RESULT: PASS");
  });

  it("refuses to write a file that contains the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbit-diagnosis-"));
    try {
      await expect(
        writeDiagnosis(
          root,
          "2026-10-10T07-00-00Z",
          file("echo " + SYNTHETIC_KEY),
          SYNTHETIC_KEY,
        ),
      ).rejects.toThrow("EVAL_DIAGNOSIS_SECRET");
      expect(await readdir(root)).toEqual([]);
      await expect(
        writeDiagnosis(root, "2026-10-10T07-00-00Z", file("ok"), ""),
      ).rejects.toThrow("EVAL_DIAGNOSIS_SECRET_REQUIRED");
      await expect(
        writeDiagnosis(root, "../evidence", file("ok"), SYNTHETIC_KEY),
      ).rejects.toThrow("EVAL_DIAGNOSIS_STAMP_INVALID");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
