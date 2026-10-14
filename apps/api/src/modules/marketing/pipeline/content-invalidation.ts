import type { DbTx } from "../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../packages/schemas/src/index.ts";
import { data, list, update } from "../shared.ts";

/** Blocks derived publication work when its content source changes. */
export async function invalidateContent(tx: DbTx, scope: Scope, id: string) {
  for (const kind of ["approvals", "publications"])
    for (const row of await list(tx, scope, kind))
      if (
        data(row).contentId === id &&
        ![
          "published",
          "published_test",
          "canceled",
          "outcome_unknown",
        ].includes(data(row).status)
      )
        await update(tx, scope, row, {
          ...data(row),
          status: "blocked_dependency",
          reason: "CONTENT_CHANGED",
        });
}
