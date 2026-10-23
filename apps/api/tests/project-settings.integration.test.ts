import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authDb,
  closeDatabase,
  scoped,
} from "../../../packages/db/src/index.ts";
import type { Scope } from "../../../packages/schemas/src/index.ts";
import { makeAuth } from "../src/auth.ts";
import { CLIENT_IP_HEADER } from "../src/client-ip.ts";
import { buildServer } from "../src/server.ts";
import { assertCampaignContext } from "../src/modules/marketing/brand/marketing-profile.ts";

const enabled = Boolean(
  process.env.TEST_DATABASE_URL && process.env.TEST_AUTH_DATABASE_URL,
);

/**
 * Project-wide content languages and profile links
 * (plans/project-configuration-i18n.md): persistence through the owner
 * action, the content-free audit, the owner-only permission and the
 * campaign language rule.
 */
describe.skipIf(!enabled)("Project settings: languages and links", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let scope: Scope;
  const users: string[] = [];
  const workspaces: string[] = [];
  const origin = process.env.APP_ORIGIN!;
  const ip = () =>
    `198.18.${randomBytes(1)[0]}.${(randomBytes(1)[0]! % 254) + 1}`;
  const signIn = async (email: string, password: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin, [CLIENT_IP_HEADER]: ip() },
      payload: { email, password },
    });
    expect(response.statusCode).toBe(200);
    const set = response.headers["set-cookie"];
    return (Array.isArray(set) ? set : [set])
      .map((v) => v!.split(";")[0])
      .join("; ");
  };
  const call = (
    cookie: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) =>
    app.inject({
      method,
      url,
      headers: { origin, cookie, [CLIENT_IP_HEADER]: ip() },
      ...(payload ? { payload } : {}),
    });
  const user = async (name: string) => {
    const email = `${randomUUID()}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const created = await makeAuth().api.signUpEmail({
      body: { email, name, password },
    });
    users.push(created.user.id);
    return { id: created.user.id, email, password };
  };
  let ownerCookie = "";
  let editorCookie = "";
  const settingsUrl = () =>
    `/api/projects/${scope.projectId}/actions/project-settings`;
  const links = [
    { type: "website", label: "Website", url: "https://orbit.example" },
    {
      type: "instagram",
      label: "Instagram",
      url: "https://instagram.com/orbit",
    },
    { type: "app_store", label: "iOS", url: "https://apps.apple.com/app/id1" },
    { type: "custom", label: "Status", url: "https://status.orbit.example" },
  ];

  beforeAll(async () => {
    app = await buildServer();
    const owner = await user("Synthetic settings owner");
    const workspace = await authDb.workspace.create({
      data: {
        name: "Synthetic project settings",
        members: { create: { userId: owner.id, role: "owner" } },
      },
    });
    workspaces.push(workspace.id);
    ownerCookie = await signIn(owner.email, owner.password);
    const project = await call(ownerCookie, "POST", "/api/projects", {
      name: "Synthetic settings",
      workspaceId: workspace.id,
      language: "de",
    });
    expect(project.statusCode).toBe(201);
    scope = {
      workspaceId: workspace.id,
      projectId: project.json().id,
      userId: owner.id,
      role: "owner",
    };
    const editor = await user("Synthetic settings editor");
    await authDb.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: editor.id, role: "viewer" },
    });
    await authDb.projectMember.create({
      data: {
        workspaceId: workspace.id,
        projectId: scope.projectId,
        userId: editor.id,
        role: "editor",
      },
    });
    editorCookie = await signIn(editor.email, editor.password);
  });
  afterAll(async () => {
    await authDb.workspace.deleteMany({ where: { id: { in: workspaces } } });
    await authDb.user.deleteMany({ where: { id: { in: users } } });
    await app?.close();
    await closeDatabase();
  });

  const project = async (cookie = ownerCookie) => {
    const me = await call(cookie, "GET", "/api/me");
    expect(me.statusCode).toBe(200);
    return (me.json().projects as Array<Record<string, any>>).find(
      (p) => p.id === scope.projectId,
    )!;
  };

  it("creates a project with its language as the only content language", async () => {
    const p = await project();
    expect(p.language).toBe("de");
    expect(p.contentLanguages).toEqual(["de"]);
    expect(p.links).toEqual([]);
  });

  it("saves several languages, a new default and links for the owner", async () => {
    const response = await call(ownerCookie, "POST", settingsUrl(), {
      name: "Synthetic settings",
      timezone: "Europe/Berlin",
      contentLanguages: ["de", "en", "pt-br"],
      defaultContentLanguage: "en",
      links,
    });
    expect(response.statusCode).toBe(200);
    const p = await project();
    expect(p.language).toBe("en");
    expect(p.contentLanguages).toEqual(["de", "en", "pt-BR"]);
    expect(p.links).toEqual(links);
    // Members read the same settings.
    expect((await project(editorCookie)).contentLanguages).toEqual([
      "de",
      "en",
      "pt-BR",
    ]);
    const events = await scoped(scope.workspaceId, scope.projectId, (tx) =>
      tx.auditEvent.findMany({
        where: {
          projectId: scope.projectId,
          action: "project_settings.update",
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      language: "en",
      contentLanguages: ["de", "en", "pt-BR"],
      linkCount: 4,
    });
    // Content-free: no address reaches the audit trail.
    expect(JSON.stringify(events[0]!.metadata)).not.toContain("https://");
  });

  it("keeps links when only the name changes, as the old form sends it", async () => {
    const response = await call(ownerCookie, "POST", settingsUrl(), {
      name: "Renamed settings",
      timezone: "Europe/Berlin",
    });
    expect(response.statusCode).toBe(200);
    const p = await project();
    expect(p.name).toBe("Renamed settings");
    expect(p.links).toEqual(links);
    expect(p.contentLanguages).toEqual(["de", "en", "pt-BR"]);
  });

  it("refuses invalid languages and links without changing anything", async () => {
    for (const payload of [
      { contentLanguages: ["de"], defaultContentLanguage: "fr" },
      { contentLanguages: ["deutsch"] },
      {
        links: [
          { type: "tiktok", label: "TikTok", url: "https://evil.example" },
        ],
      },
      {
        links: [
          { type: "website", label: "Site", url: "http://orbit.example" },
        ],
      },
    ]) {
      const response = await call(ownerCookie, "POST", settingsUrl(), {
        name: "Renamed settings",
        timezone: "Europe/Berlin",
        ...payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const p = await project();
    expect(p.contentLanguages).toEqual(["de", "en", "pt-BR"]);
    expect(p.links).toEqual(links);
  });

  it("lets only owners change the project settings", async () => {
    const response = await call(editorCookie, "POST", settingsUrl(), {
      name: "Editor rename",
      timezone: "Europe/Berlin",
      contentLanguages: ["fr"],
      defaultContentLanguage: "fr",
    });
    expect(response.statusCode).toBe(403);
    expect((await project()).name).toBe("Renamed settings");
  });

  it("approves campaigns in any project content language, besides the profile's", async () => {
    const at = new Date();
    const facts = await scoped(
      scope.workspaceId,
      scope.projectId,
      async (tx) => {
        const source = await tx.entity.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "sources",
            data: { status: "active", publicUse: true, title: "Site" },
          },
        });
        const fact = await tx.entity.create({
          data: {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            kind: "facts",
            data: {
              key: "official.website",
              value: "https://orbit.example",
              valueType: "url",
              status: "verified",
              publicUse: true,
              sourceId: source.id,
              validFrom: new Date(at.valueOf() - 60_000).toISOString(),
            },
          },
        });
        return { fact };
      },
    );
    const profile = await call(
      ownerCookie,
      "PUT",
      `/api/projects/${scope.projectId}/marketing-profile`,
      {
        productName: "Orbit",
        contentLanguage: "de",
        internalLanguage: "de",
        audience: "Teams",
        positioning: "Modular",
        productStrategy: "Product",
        presaleStrategy: "None",
        voice: ["Clear"],
        guardrails: ["No promises"],
        primaryCtas: ["Sign up"],
        channelPriority: ["x"],
        notificationPreference: "none",
        officialLinks: [
          {
            label: "Website",
            url: "https://orbit.example",
            factId: facts.fact.id,
          },
        ],
        assetPolicy: "approved_only",
      },
    );
    expect(profile.statusCode).toBeLessThan(300);
    const version = profile.json().version as number;
    const campaign = (language: string) =>
      scoped(scope.workspaceId, scope.projectId, (tx) =>
        assertCampaignContext(
          tx,
          scope,
          {
            profileVersion: version,
            campaignType: "product",
            targetAction: "Sign up",
            targetUrl: "https://orbit.example",
            language,
          },
          at,
        ),
      );
    await expect(campaign("de")).resolves.toBeTruthy();
    await expect(campaign("pt-BR")).resolves.toBeTruthy();
    await expect(campaign("fr")).rejects.toThrow(
      "CAMPAIGN_LANGUAGE_NOT_APPROVED",
    );
  });
});
