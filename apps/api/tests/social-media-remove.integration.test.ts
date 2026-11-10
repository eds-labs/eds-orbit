import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Records, when the platform purges files, whether they were already marked
// deleted and their library entry gone: the decision to delete and making
// the files unusable must be one transaction, so a post cannot attach the
// image in between (its media would vanish with the purged file).
const seen = vi.hoisted(() => ({ calls: [] as Array<{ ids: string[] }>, check: null as null | ((ids: string[]) => Promise<void>) }));
vi.mock("../src/platform/files/files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/platform/files/files.ts")>();
  return {
    ...actual,
    purgeMarkedFiles: (async (scope, ids) => {
      seen.calls.push({ ids: [...ids] });
      await seen.check?.([...ids]);
      return actual.purgeMarkedFiles(scope, ids);
    }) as typeof actual.purgeMarkedFiles,
  };
});

import { closeDatabase } from "../../../packages/db/src/index.ts";
import { removeMedia, uploadMedia } from "../src/modules/social/media/library.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const PNG = readFileSync(new URL("./fixtures/social/photo-800x600.png", import.meta.url));

describe.skipIf(!enabled)("removing a library image", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;

  beforeAll(async () => {
    Object.assign(process.env, {
      ORBIT_SOCIAL: "true",
      ORBIT_FILES: "true",
      FILES_BACKEND: "database",
      FILES_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    });
    p = await createSocialProject();
  });
  afterAll(async () => {
    await p?.cleanup();
    await closeDatabase();
  });

  it("marks both files deleted and drops the entry before purging them", async () => {
    const view = await uploadMedia(p.editor, { bytes: PNG, mime: "image/png" });
    const asset = await p.run((tx) => tx.socialMediaAsset.findUniqueOrThrow({ where: { id: view.id } }));
    let state: { marked: number; entries: number } | null = null;
    seen.check = async (ids) => {
      state = await p.run(async (tx) => ({
        marked: await tx.file.count({ where: { id: { in: ids }, deletedAt: { not: null } } }),
        entries: await tx.socialMediaAsset.count({ where: { id: view.id } }),
      }));
    };
    expect(await removeMedia(p.editor, view.id)).toEqual({ id: view.id, removed: "deleted" });
    expect(seen.calls.at(-1)?.ids.sort()).toEqual([asset.fileId, asset.jpegFileId].sort());
    expect(state).toEqual({ marked: 2, entries: 0 });
    const left = await p.run((tx) => tx.file.count({ where: { id: { in: [asset.fileId, asset.jpegFileId] } } }));
    expect(left).toBe(0);
  });
});
