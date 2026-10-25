import type { DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { PermissionDef } from "../../../../../packages/module-contracts/src/index.ts";

/** What a module tells about one of its objects for a link (ADR 0016). */
export type ResolvedObject = {
  title: string;
  status?: string;
  statusCategory?: string;
  /** In-app path below the project, such as /p/<id>/work/tasks?task=<id>. */
  href: string;
  /** The title may hold personal data: tools outside the app leave it out. */
  sensitive?: boolean;
};

/**
 * A type of object other modules may link to, contributed by its module as
 * `linkTypes[<local type>]`; its full type is "<module>.<local type>".
 */
export type LinkTypeDef = {
  label: { en: string; de: string };
  /** Needed to link to, unlink from or see the details of such an object. */
  linkPermission: PermissionDef;
  /**
   * The objects by id, archived ones included; a missing id means the
   * object is deleted (a weekly check then removes its links).
   */
  resolve(
    tx: DbTx,
    scope: Scope,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, ResolvedObject>>;
  /** Candidates for a link picker, matched by title or number. */
  search?(
    tx: DbTx,
    scope: Scope,
    query: string,
    limit: number,
  ): Promise<Array<{ id: string; title: string }>>;
};
