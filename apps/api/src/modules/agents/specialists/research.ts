import { z } from "zod";
import { agentKnowledgeSearch } from "../tools/agent-tools.ts";
import {
  DEFAULT_SPECIALIST_LIMITS,
  normalizeSourceUrl,
  type Specialist,
} from "./types.ts";

const text = (max: number) =>
  z.string().refine((value) => value.length > 0 && value.length <= max);

const finding = z
  .object({
    claim: text(500),
    // Strict output cannot express a URI format; the check runs on the parsed answer.
    sourceUrl: text(500).refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
    sourceTitle: text(200),
    // The day the page was read or published.
    observedAt: z.iso.date(),
  })
  .strict();

export const researchOutput = z
  .object({ findings: z.array(finding).max(6) })
  .strict();

/**
 * Research specialist: OpenAI hosted web search plus the knowledge search.
 * Its findings are leads for the strategy and stay on the task output; they
 * are never written to facts or sources (spec D6).
 */
export const researchSpecialist: Specialist = {
  role: "research",
  taskClass: "agent_research",
  instructions: [
    "You are the research specialist. Find current, relevant public information for the assignment's topic frame with web search (at most three searches) and use knowledge_search to see what Orbit already knows.",
    "Every finding is one checkable claim taken from one page you found: claim (your wording, no quotation of long passages), sourceUrl (the https URL of that page exactly as the search returned it; a finding whose page the searches did not return is discarded), sourceTitle and observedAt (the day the page was published or you read it, YYYY-MM-DD).",
    "All findings are unverified leads, never facts: do not state that anything is confirmed, and do not report a claim without a page you actually found. Prefer primary and recent sources; skip anything you cannot tie to a URL. If nothing useful is found, return an empty findings array.",
  ].join(" "),
  tools: [agentKnowledgeSearch],
  hostedTools: [{ type: "web_search" }],
  outputSchema: researchOutput,
  limits: { ...DEFAULT_SPECIALIST_LIMITS },
  // A source the searches did not return or cite is invented: the finding is dropped.
  finalize: (output: z.infer<typeof researchOutput>, sources) => ({
    findings: output.findings.filter((finding) => {
      const url = normalizeSourceUrl(finding.sourceUrl);
      return url !== null && sources.has(url);
    }),
  }),
};
