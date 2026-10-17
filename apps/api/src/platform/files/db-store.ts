import { scoped } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import { ObjectStoreError, type ObjectStore } from "./s3.ts";

// The database backend of platform files (WP4.6, Mario 2026-10-17): the
// same encrypted objects as the S3 backend, kept in `FileBlob` under the
// project's row-level security. They go with the database backup and are
// deleted with their project. Each call runs in its own project
// transaction, like a call to the bucket would.

/** A store for one project; a key of another project is refused. */
export function databaseStore(scope: Scope): ObjectStore {
  const prefix = `projects/${scope.projectId}/`;
  const run = async <T>(key: string, work: Parameters<typeof scoped<T>>[2]) => {
    if (!key.startsWith(prefix))
      throw new ObjectStoreError("OBJECT_KEY_INVALID");
    return scoped(scope.workspaceId, scope.projectId, work);
  };
  return {
    put: (key, body) =>
      run(key, (tx) =>
        tx.fileBlob
          .create({
            data: {
              key,
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              data: Buffer.from(body),
            },
          })
          .then(() => undefined),
      ),
    get: (key) =>
      run(key, async (tx) => {
        const row = await tx.fileBlob.findUnique({ where: { key } });
        return row ? new Uint8Array(row.data) : null;
      }),
    delete: (key) =>
      run(key, (tx) =>
        tx.fileBlob.deleteMany({ where: { key } }).then(() => undefined),
      ),
  };
}
