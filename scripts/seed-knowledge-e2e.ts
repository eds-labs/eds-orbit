// Creates only synthetic users in this feature worktree test database.
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { makeAuth } from "../apps/api/src/auth.ts";
import { authDb, closeDatabase } from "../packages/db/src/index.ts";
if (
  !new URL(process.env.DATABASE_URL!).pathname.startsWith(
    "/orbit_test_eds_orbit_knowledge_",
  )
)
  throw new Error("Isolated knowledge test database required");
const email = `knowledge-${randomUUID()}@example.invalid`,
  password = randomBytes(24).toString("hex");
const result = await makeAuth().api.signUpEmail({
  body: { email, password, name: "Synthetic Mario" },
});
const w = await authDb.workspace.create({
  data: {
    name: "Synthetic Knowledge Workspace",
    members: { create: { userId: result.user.id, role: "owner" } },
  },
});
const p = await authDb.project.create({
  data: {
    workspaceId: w.id,
    name: "FamilyPlan knowledge preview",
    language: "de",
    timezone: "Europe/Berlin",
  },
});
writeFileSync(
  ".runtime/knowledge-e2e.json",
  JSON.stringify({ email, password, projectId: p.id, workspaceId: w.id }),
  { mode: 0o600 },
);
await closeDatabase();
console.log("Synthetic browser account created.");
