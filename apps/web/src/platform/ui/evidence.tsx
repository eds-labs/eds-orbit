"use client";
// Evidence of a knowledge answer (facts and source passages), shown by every
// module that cites knowledge (plans/orbit-modularization/04 §5).
import type { Entity } from "@/lib/api";
import { Alert, Badge } from "@/components/ui/primitives";
export type EvidenceLabels = {
  fact: string;
  passage: string;
  document: string;
  relevance: string;
};
const ENGLISH: EvidenceLabels = {
  fact: "Fact",
  passage: "Source passage",
  document: "Source document",
  relevance: "relevance",
};
/**
 * The labels, the rendering of reason and gap codes and the lookup of source
 * names default to English and raw values, so callers that pass nothing keep
 * their output.
 */
export function EvidenceItems({
  evidence,
  labels = ENGLISH,
  mapCode = String,
  sourceName,
}: {
  evidence: Entity;
  labels?: EvidenceLabels;
  mapCode?: (code: unknown) => string;
  sourceName?: (id: string) => string | undefined;
}) {
  const facts = Array.isArray(evidence.data.facts)
    ? (evidence.data.facts as Record<string, unknown>[])
    : [];
  const items = Array.isArray(evidence.data.items)
    ? (evidence.data.items as Record<string, unknown>[])
    : [];
  return (
    <div className="evidence-items">
      {facts.map((f, i) => (
        <div key={String(f.id || i)}>
          <Badge tone="blue">
            {labels.fact} v{String(f.version || "1")}
          </Badge>
          <strong>
            {String(f.key)}: {String(f.value)}
          </strong>
          <small>
            {sourceName?.(String(f.sourceId || "")) ?? String(f.sourceId || "")}
          </small>
        </div>
      ))}
      {items.map((f, i) => (
        <div key={String(f.chunkId || i)}>
          <strong>{String(f.title || labels.passage)}</strong>
          <p>{String(f.text || "")}</p>
          <small>
            {String(f.anchor || "")}
            {typeof f.canonicalUrl === "string" &&
              f.canonicalUrl.startsWith("https://") && (
                <>
                  {" "}
                  ·{" "}
                  <a href={f.canonicalUrl} target="_blank" rel="noreferrer">
                    {labels.document}
                  </a>
                </>
              )}
          </small>
          {Array.isArray(f.reasons) && (
            <small>
              {f.reasons.map(mapCode).join(" · ")}{" "}
              {typeof f.score === "number"
                ? `· ${labels.relevance} ${f.score.toFixed(4)}`
                : ""}
            </small>
          )}
        </div>
      ))}
      {Array.isArray(evidence.data.gaps) && evidence.data.gaps.length > 0 && (
        <Alert kind="warning">
          {evidence.data.gaps.map(mapCode).join(" · ")}
        </Alert>
      )}
    </div>
  );
}
