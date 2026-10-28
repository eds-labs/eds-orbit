"use client";
import Image from "next/image";
import { usd } from "@/lib/api";
import type { ActionRequestRenderer } from "@/platform/assistant/extensions";
import { Button } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";

// The approval of one internal creative preview (MCP or the assistant): the
// post text and image copy exactly as proposed, the art it draws (a chosen
// approved asset, shown, or new paid art with its exact prompt) and what the
// approval does not do. The platform frame adds the effect, cost and expiry.

export const PREVIEW_ACTION =
  "marketing.mcp.marketing_creative_preview_create";

type Operation = {
  channel?: string;
  format?: string;
  template?: string;
  title?: string;
  postText?: string;
  copy?: { eyebrow?: string; headline?: string; subline?: string; cta?: string };
  art?: "generate" | "asset" | "none";
  artAssetId?: string;
  maxBudgetMicros?: number;
  approvalContext?: { artPrompt?: string | null; ceilingMicros?: number };
};

const ART = {
  generate: { en: "New AI image (paid)", de: "Neues KI-Bild (kostenpflichtig)" },
  asset: { en: "Approved image from the library", de: "Freigegebenes Bild aus der Bibliothek" },
  none: { en: "No image, layout only", de: "Kein Bild, nur Layout" },
};

export const creativePreviewRenderer: ActionRequestRenderer = {
  accepts: (item) => typeof item.summary?.operation?.postText === "string",
  component: ({ item, de, pending, decide }) => {
    const { project } = useWorkspace();
    const op = item.summary.operation as Operation;
    const art = ART[op.art ?? "none"] ?? ART.none;
    return (
      <article className="action-request creative-request-preview">
        <h3>
          {de ? "Interne Creative-Vorschau erstellen" : "Create internal creative preview"}
        </h3>
        <p>
          {[op.channel, op.format, op.template].filter(Boolean).join(" · ")}
        </p>
        <blockquote className="chat-package-draft">{op.postText}</blockquote>
        {op.copy && (
          <dl className="approval-fields">
            {(["eyebrow", "headline", "subline", "cta"] as const)
              .filter((key) => op.copy?.[key])
              .map((key) => (
                <div key={key}>
                  <dt>
                    {
                      {
                        eyebrow: de ? "Dachzeile" : "Eyebrow",
                        headline: de ? "Überschrift" : "Headline",
                        subline: de ? "Unterzeile" : "Subline",
                        cta: de ? "Handlungsaufruf" : "Call to action",
                      }[key]
                    }
                  </dt>
                  <dd>{op.copy![key]}</dd>
                </div>
              ))}
          </dl>
        )}
        <p>
          <strong>{de ? "Bild" : "Image"}:</strong> {de ? art.de : art.en}
        </p>
        {op.art === "asset" && op.artAssetId && (
          <Image
            unoptimized
            src={`/api/projects/${encodeURIComponent(project.id)}/assets/${encodeURIComponent(op.artAssetId)}/content`}
            width={200}
            height={200}
            alt={de ? "Gewähltes Bild" : "Chosen image"}
          />
        )}
        {op.art === "generate" && op.approvalContext?.artPrompt && (
          <>
            <p className="chat-package-note">
              {de
                ? "Dieser Bildauftrag geht genau so an den Bildanbieter:"
                : "This image prompt goes to the image provider exactly as shown:"}
            </p>
            <blockquote className="chat-package-draft">
              {op.approvalContext.artPrompt}
            </blockquote>
          </>
        )}
        {typeof op.maxBudgetMicros === "number" && (
          <p className="chat-package-note">
            {de ? "Eigenes Limit dieser Vorschau" : "This preview's own limit"}:{" "}
            {usd(op.maxBudgetMicros)}
          </p>
        )}
        <p className="chat-package-note">
          {de
            ? "Die Vorschau bleibt in Orbit: keine Veröffentlichung, kein Termin, kein Postiz-Entwurf. Die Nutzungsrechte eines neuen KI-Bildes sind eine eigene Entscheidung; eine bestandene technische Prüfung ersetzt sie nicht."
            : "The preview stays in Orbit: no publication, no schedule, no Postiz draft. The usage rights of new AI art are a decision of their own; a passed technical check does not replace it."}
        </p>
        <div className="chat-links">
          <Button onClick={() => decide("approve")} disabled={pending}>
            {de ? "Freigeben" : "Approve"}
          </Button>
          <Button
            variant="outline"
            onClick={() => decide("reject")}
            disabled={pending}
          >
            {de ? "Ablehnen" : "Reject"}
          </Button>
        </div>
      </article>
    );
  },
};
