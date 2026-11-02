import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../../../packages/db/src/index.ts";
import {
  beginOAuthState,
  consumeOAuthState,
  projectOfState,
  socialOAuthStateCleanup,
} from "../src/modules/social/accounts/oauth-state.ts";
import { createSocialProject } from "./support/social-project.ts";

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL);
const MINUTE = 60_000;

/**
 * OAuth state (ADR 0020, S2 Task 4): single use, bound to the member and
 * the project, ten minutes, with a sealed PKCE verifier; only the state's
 * hash is stored.
 */
describe.skipIf(!enabled)("social OAuth state", () => {
  let p: Awaited<ReturnType<typeof createSocialProject>>;
  let other: Awaited<ReturnType<typeof createSocialProject>>;
  const appConnectionId = randomUUID();
  const begin = (q = p, platform: "x" | "facebook" = "x") =>
    q.run((tx) =>
      beginOAuthState(tx, q.owner, {
        platform,
        appConnectionId,
        redirectAfter: `/p/${q.owner.projectId}/social/accounts`,
      }),
    );
  const consume = (state: string, q = p, platform: "x" | "facebook" = "x", now?: Date, scope = q.owner) =>
    q.run((tx) => consumeOAuthState(tx, scope, { state, platform }, now));

  beforeAll(async () => {
    process.env.ORBIT_SOCIAL = "true";
    p = await createSocialProject();
    other = await createSocialProject({ name: "Synthetic social B" });
  });
  afterAll(async () => {
    await p?.cleanup();
    await other?.cleanup();
    await closeDatabase();
  });

  it("round-trips with a PKCE challenge of the verifier", async () => {
    const started = await begin();
    expect(started.state.startsWith(`${p.owner.projectId}.`)).toBe(true);
    expect(projectOfState(started.state)).toBe(p.owner.projectId);
    expect(started.codeChallenge).toBe(createHash("sha256").update(started.codeVerifier).digest("base64url"));
    const consumed = await consume(started.state);
    expect(consumed).toMatchObject({
      codeVerifier: started.codeVerifier,
      appConnectionId,
      redirectAfter: `/p/${p.owner.projectId}/social/accounts`,
    });
    expect(consumed.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(consumed.expiresAt.getTime() - consumed.createdAt.getTime()).toBe(10 * MINUTE);
  });

  it("stores neither the state nor the verifier in plain text", async () => {
    const started = await begin();
    const rows = await p.run((tx) => tx.socialOAuthState.findMany({ where: { projectId: p.owner.projectId } }));
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(started.state);
    expect(dump).not.toContain(started.codeVerifier);
    expect(rows.some((r) => r.stateHash === createHash("sha256").update(started.state).digest("hex"))).toBe(true);
  });

  it("refuses a second use", async () => {
    const started = await begin();
    await consume(started.state);
    await expect(consume(started.state)).rejects.toMatchObject({ code: "SOCIAL_OAUTH_STATE_INVALID", status: 403 });
  });

  it("refuses another member", async () => {
    const started = await begin();
    await expect(consume(started.state, p, "x", undefined, p.editor)).rejects.toMatchObject({ code: "SOCIAL_OAUTH_STATE_INVALID" });
  });

  it("refuses an expired state", async () => {
    const started = await begin();
    await expect(consume(started.state, p, "x", new Date(Date.now() + 11 * MINUTE))).rejects.toMatchObject({
      code: "SOCIAL_OAUTH_STATE_INVALID",
    });
  });

  it("refuses a state of another project", async () => {
    const started = await begin(p);
    await expect(consume(started.state, other)).rejects.toMatchObject({ code: "SOCIAL_OAUTH_STATE_INVALID" });
  });

  it("refuses a tampered state and the wrong platform", async () => {
    const started = await begin();
    await expect(consume(`${started.state}x`)).rejects.toMatchObject({ code: "SOCIAL_OAUTH_STATE_INVALID" });
    await expect(consume(started.state, p, "facebook")).rejects.toMatchObject({ code: "SOCIAL_OAUTH_STATE_INVALID" });
  });

  it("refuses a state without a project prefix", () => {
    expect(() => projectOfState("not-a-state")).toThrow(expect.objectContaining({ code: "SOCIAL_OAUTH_STATE_INVALID" }));
  });

  it("keeps the return path inside the project's social module", async () => {
    await expect(
      p.run((tx) =>
        beginOAuthState(tx, p.owner, { platform: "x", appConnectionId, redirectAfter: "https://evil.example/" }),
      ),
    ).rejects.toMatchObject({ code: "SOCIAL_REDIRECT_INVALID", status: 400 });
    await expect(
      p.run((tx) =>
        beginOAuthState(tx, p.owner, {
          platform: "x",
          appConnectionId,
          redirectAfter: `/p/${other.owner.projectId}/social/accounts`,
        }),
      ),
    ).rejects.toMatchObject({ code: "SOCIAL_REDIRECT_INVALID" });
  });

  it("cleans up only states that expired more than a day ago", async () => {
    const old = await begin();
    const fresh = await begin();
    await p.run((tx) =>
      tx.socialOAuthState.updateMany({
        where: { stateHash: createHash("sha256").update(old.state).digest("hex") },
        data: { createdAt: new Date(Date.now() - 3 * 24 * 60 * MINUTE), expiresAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE) },
      }),
    );
    expect(await p.run((tx) => socialOAuthStateCleanup.nextDueAt!(tx, p.owner))).not.toBeNull();
    await socialOAuthStateCleanup.run(p.owner);
    const hashes = (await p.run((tx) => tx.socialOAuthState.findMany({ where: { projectId: p.owner.projectId } }))).map(
      (r) => r.stateHash,
    );
    expect(hashes).not.toContain(createHash("sha256").update(old.state).digest("hex"));
    expect(hashes).toContain(createHash("sha256").update(fresh.state).digest("hex"));
    expect(await p.run((tx) => socialOAuthStateCleanup.nextDueAt!(tx, p.owner))).toBeNull();
  });
});
