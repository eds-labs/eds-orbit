import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDatabase,
  scoped,
  type DbTx,
} from "../../../packages/db/src/index.ts";
import { create, data, entity, list } from "../src/shared.ts";
import { createConversation } from "../src/modules/chat.ts";
import { requestContentPackage } from "../src/modules/agents/content-packages.ts";
import {
  createPackageProject,
  OFFICIAL_URL,
  X,
} from "./support/package-project.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);
// Not in the policy's allowedOrigins, like https://uliquid.vip in production.
const WEBSITE = "https://website.example.org";
const SIGNUP = `${OFFICIAL_URL}/signup`;

/**
 * A post targets an official link the policy allows. Production uLiquid lists
 * its website first while the policy allows only the app domain; every
 * package stopped with LINK_NOT_ALLOWED.
 */
describe.skipIf(!enabled)("Official target link within the policy", () => {
  let project: Awaited<ReturnType<typeof createPackageProject>>;
  let links: Record<"website" | "official" | "signup", Record<string, string>>;
  const run = <T>(work: (tx: DbTx) => Promise<T>) =>
    scoped(project.owner.workspaceId, project.owner.projectId, work);
  const setLinks = (order: Array<keyof typeof links>) =>
    run(async (tx) => {
      const profile = await tx.projectMarketingProfile.findFirstOrThrow({
        where: { projectId: project.owner.projectId },
      });
      await tx.projectMarketingProfile.update({
        where: { id: profile.id },
        data: {
          data: {
            ...(profile.data as object),
            officialLinks: order.map((name) => links[name]),
          },
        },
      });
    });
  const packageTarget = async (factKeys: string[]) => {
    const thread = await createConversation(project.owner);
    const { actionRequest } = await requestContentPackage(
      project.owner,
      thread.id,
      { goal: "Announce that beta access is open", channels: [X], factKeys },
    );
    return data(
      await run((tx) =>
        entity(tx, project.owner, "action_requests", actionRequest.id),
      ),
    ).payload.deliverables[0].mission.targetUrl as string;
  };

  beforeAll(async () => {
    process.env.ORBIT_CONTENT_PACKAGES = "true";
    project = await createPackageProject();
    const { owner } = project;
    await run(async (tx) => {
      const fact = (key: string, value: string) =>
        create(tx, owner, "facts", {
          key,
          value,
          valueType: "url",
          language: "en",
          sourceId: project.sourceId,
          sourceGeneration: 1,
          validFrom: new Date(Date.now() - 3600000).toISOString(),
          validUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
          status: "verified",
          publicUse: true,
          modelUse: true,
        });
      const official = (await list(tx, owner, "facts")).find(
        (row) => data(row).key === "official.link",
      )!;
      links = {
        website: {
          label: "Website",
          url: WEBSITE,
          factId: (await fact("url.website", WEBSITE)).id,
        },
        official: { label: "Official", url: OFFICIAL_URL, factId: official.id },
        signup: {
          label: "Beta registration",
          url: SIGNUP,
          factId: (await fact("url.signup", SIGNUP)).id,
        },
      };
    });
  });
  afterAll(async () => {
    delete process.env.ORBIT_CONTENT_PACKAGES;
    await project.cleanup();
    await closeDatabase();
  });

  it("gives a package the first allowed link when the first official link is not allowed", async () => {
    await setLinks(["website", "official", "signup"]);
    expect(await packageTarget(["beta.access"])).toBe(OFFICIAL_URL);
  });

  it("prefers the allowed link whose fact the package states", async () => {
    await setLinks(["website", "official", "signup"]);
    expect(await packageTarget(["beta.access", "url.signup"])).toBe(SIGNUP);
  });

  it("names the blocker when no official link is allowed", async () => {
    await setLinks(["website"]);
    await expect(packageTarget(["beta.access"])).rejects.toThrow(
      "LINK_NOT_ALLOWED",
    );
  });
});
