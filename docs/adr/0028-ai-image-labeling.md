# ADR 0028: Central AI image labelling and provenance

- Status: accepted (2026-11-13); live in production with the flag on since 2026-11-13 14:36 UTC
- Owner: Mario
- Flag: `ORBIT_AI_IMAGE_LABELS` (default `false`)

## Context

Orbit generates marketing images with OpenAI (`generateProjectImageTraced`) and
turns them into finished images in three places: Creative Studio renditions
(`composeCreative`), the brand banner (`renderRasterBanner`) and template
renders (`renderRasterTemplate`). Three paths attach a raw generated image to a
post directly (`attachRunImage`, `attachRawImage`, mission `assetIds`). Images
leave Orbit through Postiz, the Social module (X, Facebook, Instagram,
Telegram) and the content bundle export.

Nothing recorded centrally whether an image is AI-generated. Composed creatives
were stored as `TEMPLATE_GENERATED` even over generated art, every sharp encode
dropped metadata (including the C2PA manifest OpenAI embeds), and the Social
library re-encoded images without any origin. EU AI Act Art. 50 and platform
rules expect AI-generated or AI-manipulated images to be recognisable as such.

## Decision

1. **One labelling engine** in `packages/creative/src/ai-label.ts`:
   - `applyAiLabel(bytes, {origin, composite?, avoid?, safe?, knownLabel?})`
     draws the exact text **"KI erstellt"** at the bottom right of the
     finished image, keeps format (PNG, JPEG, WebP) and size, and writes an XMP
     packet with `Iptc4xmpExt:DigitalSourceType` (`trainedAlgorithmicMedia`, or
     `compositeWithTrainedAlgorithmicMedia` for composites and substantial AI
     edits) plus `orbit:aiLabel`, `orbit:aiLabelVersion`, `orbit:aiLabelBox`.
   - The letters are fixed vector glyphs (no installed font), so drawing and
     checking give the same pixels on every machine.
   - Size: capitals 2.4 % of the short side (16..72 px). Margin: 3.5 % of the
     short side, at least 16 px, or the format's safe insets when larger.
   - Contrast: dark plate with white letters, or light plate with near-black
     letters, chosen from the region's luminance; the plate starts at 60 %
     opacity and gets more opaque until the letters reach 4.5:1 against the
     worst 5 % of the plate.
   - Protected layers (logo, logo plate, text) are passed as `avoid` boxes;
     the label moves above them (right-aligned) or left of them on the same
     line and never covers them. No room fails closed
     (`AI_LABEL_PLACEMENT_FAILED`). Logos, brand colours and copy are never
     changed.
   - Idempotent: an image whose XMP (or the central record, `knownLabel`)
     already names a label is verified and returned unchanged. A recorded
     label that no longer verifies throws `AI_LABEL_INVALID` instead of being
     covered by a second one.
   - `verifyAiLabel(bytes, relBox)` first rejects a box that cannot be an
     Orbit label for the canvas (`LABEL_GEOMETRY_INVALID`: aspect ratio more
     than ±15 % off the plate, taller than twice the size Orbit would draw,
     or over 250 000 px), so a forged XMP box cannot make the check
     expensive. It then renders the expected letter mask at the recorded box
     (fractions of the canvas, so valid after scaling): the mean letter
     luminance must reach 3:1 against the plate's 90th percentile on the
     letters' side, at least 90 % of plate pixels must lie on the far side
     with 2.5:1 against the letter mean, and at least 90 % of letter-core
     pixels 2.5:1 against that plate value. The drawing chooses its opacity
     with the same criterion, so drawing and checking agree on any
     background. It tolerates JPEG and downscaling and fails when the label
     is missing, covered, cut off or a different text.
   - `readImageProvenance` reads Orbit/IPTC XMP and detects an embedded C2PA
     manifest store (PNG `caBX`, JPEG APP11 JUMBF, WebP `C2PA`), including
     whether it names an AI source type. `carriedProvenanceXmp` gives the
     minimal XMP a re-encoder writes so provenance survives resizing; nothing
     else of a source's metadata is carried.
2. **One central record** per image version: platform table
   `ImageProvenance` (project-scoped, FORCE RLS), keyed by
   `(projectId, sha256)` of the exact bytes, with `origin`
   (`ai_generated` | `ai_substantially_modified` | `original_upload`),
   `labelState` (`labeled` | `not_required` | `unlabeled_source`), label box
   and version, `digitalSourceType`, `parentSha256`, component hashes,
   detected embedded provenance (XMP fields, C2PA hash/size, kept manifest
   bytes up to 1 MiB) and the module/subject that produced it. Service:
   `apps/api/src/platform/provenance/`.
3. **Labelling happens when the final asset is created**, never at publish
   time. Approvals hash the asset (bytes included), so the approved image is
   the labelled one and no existing approval changes. Raw generated art stays
   unlabelled internal source material (`unlabeled_source`) because it is
   composed further; a path that hands raw art to a post creates a labelled
   derivative asset first.
4. **Every outbound path verifies and blocks**: Marketing `preflight`
   (`AI_LABEL_MISSING` / `AI_LABEL_INVALID` blocker), the Marketing export of
   asset bytes used by Postiz, the Social handoff and the content bundle, and
   in Social `validateVariant` (issue) plus `deliverPublication` right before
   `sender.send` (covers all networks, Instagram before its public URL).
   Social ingest records provenance for its normalized original and JPEG
   rendition and writes the carried XMP, so the record follows the bytes.
5. **No retroactive change**: existing assets are never rewritten. With the
   flag on, an older AI image (generated artwork, a creative over generated
   art, or bytes declaring AI) without a valid label is blocked from
   publication; a new labelled version needs a new approval.
6. **Uploads**: an unchanged upload or one with standard edits (rotate,
   resize, crop, re-encode) is `original_upload` and gets no label. An upload
   whose own XMP/C2PA declares AI is recorded as AI and labelled on ingest.
7. **Flag**: with `ORBIT_AI_IMAGE_LABELS=false` nothing changes (no label, no
   record, no gate). Switching it on in production is Mario's decision.

## Limitations

- C2PA manifests are detected and kept in the record (and referenced in XMP
  by hash) but not re-signed into the output: a valid C2PA claim after an edit
  needs a signing certificate and a new dependency (`c2pa-node`), which need
  their own approval.
- The pixel check proves the expected letters are legible at the recorded
  place; it is not tamper-proof against a deliberate forgery of the plate.
- Raw generated art stays viewable and downloadable inside Orbit for the
  project's members; only outbound paths are gated.
- Ads has no creative upload yet; when it gets one it must call the same gate.

## Alternatives considered

- Label at publish time: rejected, it would change approved bytes and break
  every approval hash.
- Store provenance only in the assets JSON: rejected, Social files and
  derived renditions have no asset entity; the record must follow bytes.
- Text via installed fonts: rejected, glyphs differ between macOS and the
  production image (DejaVu), which breaks the pixel check.
