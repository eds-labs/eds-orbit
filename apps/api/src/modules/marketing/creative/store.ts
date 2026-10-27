import type { DbTx } from "../../../../../../packages/db/src/index.ts";
import type {
  CreativeCheck,
  CreativeCopy,
  FormatId,
  LogoPlacement,
  TemplateId,
  TextScale,
  VariantId,
} from "../../../../../../packages/creative/src/index.ts";
import {
  id as idSchema,
  type Scope,
} from "../../../../../../packages/schemas/src/index.ts";
import { data, DomainError, entity } from "../../../shared.ts";
import type { EntityRow } from "./brand-kit.ts";
import type { ResolvedBrief } from "./brief.ts";

/** Entity kind of a composed creative; read through the creative routes, not the generic collections. */
export const CREATIVES = "creatives";

/**
 * `composed`: renditions exist and passed the checks; `needs_owner`: checks
 * the service cannot correct failed; `needs_rights`: a component is not
 * (or no longer) approved for this use; `attached`: its renditions are on
 * the content rows; `superseded`: a newer creative replaced it.
 */
export type CreativeStatus =
  "composed" | "needs_owner" | "needs_rights" | "attached" | "superseded";

/** One creative as stored (spec §8). */
export type CreativeRecord = {
  contentId?: string;
  assignmentRunId?: string;
  packageId?: string;
  profileVersion: number;
  /** The resolved creative brief the creative was made from. */
  brief: ResolvedBrief;
  template: TemplateId;
  /** The variant drawn in the first format; the brief keeps the one asked for. */
  variant: VariantId;
  /** A person chose the variant: corrections never switch it (R31). */
  variantFixed?: boolean;
  options: { logoPlacement: LogoPlacement; textScale: TextScale };
  copy: CreativeCopy;
  /** The exact approved components the renditions were composed from. */
  components: {
    artAssetId?: string;
    /** The art's bytes as composed; a recompose keeps exactly these. */
    artSha256?: string;
    logo: { assetId: string; sha256: string };
    products: Array<{ assetId: string; sha256: string }>;
  };
  renditions: Array<{
    format: FormatId;
    /** The variant this format was drawn in (R1 and free corrections). */
    variant?: VariantId;
    channel?: string;
    assetId: string;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  }>;
  qa: {
    checks: CreativeCheck[];
    /** The optional vision review's verdict; its shape belongs to that review. */
    vision?: Record<string, unknown>;
    verdict: "pass" | "corrected" | "needs_owner";
  };
  /**
   * Free corrections and paid art attempts. An art attempt is recorded with
   * its image request before anything is sent and counts against
   * `maxArtCorrections` from then on; `costMicros` and the new `assetId`
   * follow once the image returned (no cost: outcome unknown).
   */
  corrections: Array<{
    kind: string;
    reason: string;
    at: string;
    costMicros?: number;
    requestId?: string;
    assetId?: string;
  }>;
  cost: {
    reservationIds: string[];
    settledMicros: number;
    unknownMicros: number;
  };
  status: CreativeStatus;
};

/** A creative as the routes return it: the record, its row data and a link to each rendition. */
export type CreativeView = Omit<CreativeRecord, "renditions"> & {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  renditions: Array<CreativeRecord["renditions"][number] & { href: string }>;
};

/** One creative of this project; another kind, project or a malformed id is `NOT_FOUND`. */
export async function findCreative(tx: DbTx, scope: Scope, id: string) {
  if (!idSchema.safeParse(id).success) throw new DomainError("NOT_FOUND", 404);
  return entity(tx, scope, CREATIVES, id);
}

/** The creative for the API: renditions link to the asset content route. */
export function creativeView(row: EntityRow, scope: Scope): CreativeView {
  const record = data(row) as CreativeRecord;
  return {
    ...record,
    id: row.id,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    renditions: (record.renditions ?? []).map((rendition) => ({
      ...rendition,
      href: `/api/projects/${scope.projectId}/assets/${rendition.assetId}/content`,
    })),
  };
}

/**
 * The newest creative of a post that no newer attach replaced, or null. The
 * post itself must be checked by the caller; a creative of another project
 * never matches.
 */
export async function latestCreativeOfContent(
  tx: DbTx,
  scope: Scope,
  contentId: string,
) {
  return tx.entity.findFirst({
    where: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      kind: CREATIVES,
      AND: [
        { data: { path: ["contentId"], equals: contentId } },
        { NOT: { data: { path: ["status"], equals: "superseded" } } },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
