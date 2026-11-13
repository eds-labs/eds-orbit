# AI image labelling ("KI erstellt")

Decision record: [ADR 0028](adr/0028-ai-image-labeling.md). Flag:
`ORBIT_AI_IMAGE_LABELS` (default `false`).

Orbit marks every new AI-generated or substantially AI-modified marketing
image with the visible label **"KI erstellt"** and records its origin
centrally. Every publish and export path checks the label and refuses an AI
image without a valid one.

## What happens with the flag on

| Step | Where | Effect |
| --- | --- | --- |
| Raw generation | `marketing/brand/image-generation.ts` | The provider's embedded provenance (OpenAI C2PA) is read before normalising. The stored art gets the provenance record `unlabeled_source` (origin `ai_generated`; `ai_substantially_modified` when reference images were edited) and `aiProvenance` in its asset JSON. Raw art stays unlabelled because it is composed further. |
| Upload in Marketing | `routes.ts` assets upload, `brand/drive-assets.ts` | An upload whose own XMP or C2PA declares AI is recorded as AI source material (`unlabeled_source`). An upload that already carries a visible, verifying Orbit label is recorded as `labeled` and never labelled again; a label named in the XMP but not visible counts as no label. Any other upload is `original_upload` and is never labelled, including after standard edits (rotate, resize, crop, re-encode). |
| Creative Studio rendition | `marketing/creative/persist.ts` `saveRenditions` | When the art is AI, the finished rendition is labelled after composition. The label avoids logo, logo plate, copy and product layers and keeps to the format's safe area. The asset and the rendition record hold the labelled bytes; the record's parent is the unlabelled composition. |
| Brand banner | `agents/specialists/visual.ts` `composeRunBanners` | Labelled after rendering; avoids logo, wordmark and logo card. |
| Template render | `marketing/brand/render-asset.ts` | Labelled when the visual is AI. |
| Labelled asset as component | `creative/components.ts`, `render-asset.ts` (`composableAsset`) | A labelled asset picked as art or visual is composed from its unlabelled source (`labeledFrom` or the record's parent), so a composite never shows two labels; without a source it is refused (409 `AI_LABELED_COMPONENT`). |
| Raw art on a post | `attachRunImage`, `attachRawImage`, mission `assetIds` | The post gets a labelled derivative asset (`labeledFrom`), created once and reused. |
| Social ingest | `social/media/library.ts` `ingestMedia` | The provenance follows the bytes into the Social library: both stored files (original and JPEG rendition) get records. An upload that declares AI is labelled on ingest; unlabelled Marketing art is refused (`AI_LABEL_MISSING`). |
| Marketing preflight | `marketing/policy/policy.ts` | Blockers `AI_LABEL_MISSING` / `AI_LABEL_INVALID` (no audit record; previews call it often). |
| Marketing export | `pipeline/content-export.ts` `exportAssetContent(…, {publish})` | Gate for Postiz upload, Social handoff, Postiz/Social draft handoff and the content bundle. A refused image never falls back to a post without image. |
| Social validation | `social/posts/validation.ts` | Error issue `SOCIAL_AI_LABEL_MISSING` (submit, approval decision, MCP `social_validate`). |
| Social delivery | `social/dispatch/deliver.ts` | Last check on the exact bytes before `sender.send` for every network (Instagram before its public URL). A refusal marks the publication `blocked` with `AI_LABEL_MISSING` or `AI_LABEL_INVALID`; the provider is never called. |

With the flag off nothing is labelled, recorded or checked; stored data is the
same as before (tests pin this for the rendition path and the Social module).

## The label

- Exact text "KI erstellt", drawn from fixed vector glyphs (independent of
  installed fonts), at the bottom right.
- Size: capitals 2.4 % of the short side (16..72 px). Margin: 3.5 % of the
  short side, at least 16 px, or the format's safe insets when larger.
- Contrast: a dark plate with white letters or a light plate with near-black
  letters, chosen from the background; at least 4.5:1 against the worst 5 %
  of the plate.
- A protected layer in the corner pushes the label above it or to its left;
  if there is no room, nothing is stored (`AI_LABEL_PLACEMENT_FAILED`).
- Running the labelling again never draws a second label: the image's XMP or
  the central record names the existing label, which is checked and kept.
- The check rejects label boxes that cannot be an Orbit label for the canvas
  (aspect ratio, size, area) before any pixel work, so a forged XMP box
  cannot make it expensive (`LABEL_GEOMETRY_INVALID`).

## Machine-readable provenance

- XMP on every labelled image: `Iptc4xmpExt:DigitalSourceType`
  (`trainedAlgorithmicMedia`, or `compositeWithTrainedAlgorithmicMedia` for
  composites and AI edits), `orbit:aiLabel`, `orbit:aiLabelVersion`,
  `orbit:aiLabelBox`, `orbit:origin`, and `orbit:sourceC2paSha256` when the
  source carried a C2PA manifest. PNG, JPEG and WebP are supported.
- The Social re-encoder carries only these fields to its outputs; camera,
  personal or other XMP is never carried.
- C2PA manifests of AI sources (OpenAI embeds one) are detected and kept in
  the central record (`ImageProvenance.c2paManifest`, up to 1 MiB) and
  referenced by hash in the XMP. For non-AI images (camera photos) only
  presence, hash and size are recorded, never the manifest bytes, which can
  name the signer or a location. Manifests are not re-signed into the
  output (see limitations).
- The Social re-encoder writes the carried XMP only with the flag on and
  only for AI images (AI source type, Orbit label, or a C2PA manifest that
  declares AI); with the flag off its output is byte-identical to before.

## Central record

Table `ImageProvenance` (platform-owned, project-scoped, FORCE RLS; the app
role may only `SELECT` and `INSERT`, rows are immutable), one row per exact
byte version (`projectId`, `sha256`): origin, label state, label box and
version, digital source type, parent and component hashes, embedded
provenance, producing module/subject. Service:
`apps/api/src/platform/provenance/image-provenance.ts`.

Blocked publications write the audit record `image.ai_label.blocked`
(content-free: code, context, origin, sha256).

## Existing media

Existing assets and Social media are never rewritten. With the flag on, an
older AI image is recognised (generated artwork, a creative or banner over
generated art, or bytes that declare AI) and blocked until a new, labelled
version exists, which needs a new approval. Scheduled posts that carry such
an image fail closed at delivery.

## Operations

- Switching on: `ORBIT_AI_IMAGE_LABELS=true` and a restart; the migration
  `202611130001_image_provenance` must be deployed first (the schema hash
  changes and needs approval in Coolify).
- Before switching on in production, check which scheduled posts carry an
  older unlabelled AI image: they will be blocked and need a labelled
  version.
- Rollback: flag off and redeploy. The table stays (no data loss); labelled
  assets keep their label.

## Limitations

- C2PA is not re-signed: a valid C2PA claim after an edit needs a signing
  certificate and the `c2pa-node` dependency, which need their own approval.
- The pixel check proves that the expected letters are legible at the
  recorded place; it does not prove the image was never forged deliberately.
- A JPEG C2PA manifest spread over several APP11 segments is hashed with its
  repeated box headers; the hash is consistent but is not the manifest's own.
- A lossless WebP input is written back as lossy WebP (quality 90); 16-bit
  PNGs become 8-bit.
- Social media ingested before the flag was on carries no record and no
  XMP, so it cannot be recognised as AI from its bytes. Marketing posts are
  still caught by Marketing's preflight at the slot, but a native Social
  post that reuses such an older library image would go out unlabelled
  (open decision: block older Marketing-origin library media, or backfill
  records).
- Social labels an AI-declaring upload without knowing where its logo is
  (no protected layers), so the label may cover part of a user-made design.
- Owner-facing previews (Telegram approval photo, MCP creative preview)
  are not gated; creative previews show the labelled rendition anyway.
- Labelling a very large upload (6000×4000) takes about 3 s inside Social's
  ingest transaction.
- Drive-only Marketing assets (no inline bytes) are checked by the export
  gate when their bytes are read, not at preflight.
- Raw generated art stays viewable and downloadable inside Orbit for project
  members; only outbound paths are gated.
- Ads has no creative upload yet; a future one must call the same gate.
