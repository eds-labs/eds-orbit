"use client";
// Evidence of a knowledge answer (facts and source passages), shown by every
// module that cites knowledge (plans/orbit-modularization/04 §5).
import type { Entity } from "@/lib/api";
import { Alert, Badge } from "@/components/ui/primitives";
export function EvidenceItems({ evidence }: { evidence: Entity }) {
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
          <Badge tone="blue">Fact v{String(f.version || "1")}</Badge>
          <strong>
            {String(f.key)}: {String(f.value)}
          </strong>
          <small>{String(f.sourceId || "")}</small>
        </div>
      ))}
      {items.map((f, i) => (
        <div key={String(f.chunkId || i)}>
          <strong>{String(f.title || "Source passage")}</strong>
          <p>{String(f.text || "")}</p>
          <small>
            {String(f.anchor || "")}
            {typeof f.canonicalUrl === "string" &&
              f.canonicalUrl.startsWith("https://") && (
                <>
                  {" "}
                  ·{" "}
                  <a href={f.canonicalUrl} target="_blank" rel="noreferrer">
                    Source document
                  </a>
                </>
              )}
          </small>
          {Array.isArray(f.reasons) && (
            <small>
              {f.reasons.join(" · ")}{" "}
              {typeof f.score === "number"
                ? `· relevance ${f.score.toFixed(4)}`
                : ""}
            </small>
          )}
        </div>
      ))}
      {Array.isArray(evidence.data.gaps) && evidence.data.gaps.length > 0 && (
        <Alert kind="warning">{evidence.data.gaps.join(" · ")}</Alert>
      )}
    </div>
  );
}
