import { describe, expect, it } from "vitest";
import { mission, marketingProfile } from "./index.ts";
import {
  languageCode,
  linkHostAllowed,
  normalizeLanguageCode,
  projectLanguages,
  projectLink,
  projectLinks,
} from "./project-settings.ts";

describe("content language codes", () => {
  it("normalizes case and separators", () => {
    expect(normalizeLanguageCode(" PT_br ")).toBe("pt-BR");
    expect(normalizeLanguageCode("zh-hant")).toBe("zh-Hant");
    expect(normalizeLanguageCode("sr-latn-rs")).toBe("sr-Latn-RS");
    expect(normalizeLanguageCode("es-419")).toBe("es-419");
  });

  it("accepts language tags and refuses everything else", () => {
    for (const ok of [
      "en",
      "de",
      "fil",
      "pt-BR",
      "zh-Hans",
      "es-419",
      "sr-Latn-RS",
    ])
      expect(languageCode.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      "",
      "e",
      "english",
      "EN",
      "pt-br",
      "de_DE",
      "en-",
      "x-klingon",
    ])
      expect(languageCode.safeParse(bad).success, bad).toBe(false);
  });

  it("requires the default among unique languages", () => {
    expect(
      projectLanguages.safeParse({
        contentLanguages: ["de", "fr"],
        defaultContentLanguage: "fr",
      }).success,
    ).toBe(true);
    expect(
      projectLanguages.safeParse({
        contentLanguages: ["de"],
        defaultContentLanguage: "en",
      }).success,
    ).toBe(false);
    expect(
      projectLanguages.safeParse({
        contentLanguages: ["de", "de"],
        defaultContentLanguage: "de",
      }).success,
    ).toBe(false);
    expect(
      projectLanguages.safeParse({
        contentLanguages: [],
        defaultContentLanguage: "de",
      }).success,
    ).toBe(false);
  });

  it("lets missions use any language tag but keeps agents on English and German", () => {
    const base = {
      title: "Launch",
      goal: "Announce the launch",
      audience: "Customers",
      channels: ["x"],
      startAt: "2026-11-01T00:00:00.000Z",
      endAt: "2026-11-02T00:00:00.000Z",
      maxContents: 1,
      targetAction: "Sign up",
    };
    expect(mission.parse({ ...base, language: "fr" }).language).toBe("fr");
    expect(mission.parse(base).language).toBe("en");
    expect(mission.safeParse({ ...base, language: "french" }).success).toBe(
      false,
    );
    const profile = marketingProfile.shape.contentLanguage;
    expect(profile.safeParse("de").success).toBe(true);
    expect(profile.safeParse("fr").success).toBe(false);
  });
});

describe("project profile links", () => {
  it("checks platform hosts, subdomains included", () => {
    expect(
      linkHostAllowed("instagram", "https://www.instagram.com/orbit"),
    ).toBe(true);
    expect(
      linkHostAllowed("instagram", "https://instagram.com.evil.example/x"),
    ).toBe(false);
    expect(linkHostAllowed("app_store", "https://apps.apple.com/app/id1")).toBe(
      true,
    );
    expect(
      linkHostAllowed(
        "google_play",
        "https://play.google.com/store/apps/details?id=a",
      ),
    ).toBe(true);
    expect(
      linkHostAllowed("google_play", "https://apps.apple.com/app/id1"),
    ).toBe(false);
    expect(linkHostAllowed("custom", "https://anything.example")).toBe(true);
  });

  it("requires HTTPS, a name and a matching platform", () => {
    const link = {
      type: "youtube",
      label: "Channel",
      url: "https://youtube.com/@orbit",
    };
    expect(projectLink.safeParse(link).success).toBe(true);
    expect(
      projectLink.safeParse({ ...link, url: "http://youtube.com/@orbit" })
        .success,
    ).toBe(false);
    expect(projectLink.safeParse({ ...link, label: "  " }).success).toBe(false);
    expect(
      projectLink.safeParse({ ...link, url: "https://vimeo.com/orbit" })
        .success,
    ).toBe(false);
    expect(projectLink.safeParse({ ...link, type: "myspace" }).success).toBe(
      false,
    );
    expect(projectLink.safeParse({ ...link, extra: 1 }).success).toBe(false);
  });

  it("supports every requested platform and refuses duplicate addresses", () => {
    const links = [
      ["x", "https://x.com/orbit"],
      ["telegram", "https://t.me/orbit"],
      ["linkedin", "https://www.linkedin.com/company/orbit"],
      ["instagram", "https://instagram.com/orbit"],
      ["facebook", "https://facebook.com/orbit"],
      ["tiktok", "https://www.tiktok.com/@orbit"],
      ["youtube", "https://youtu.be/abc"],
      ["threads", "https://www.threads.net/@orbit"],
      ["bluesky", "https://bsky.app/profile/orbit.example"],
      ["pinterest", "https://pinterest.com/orbit"],
      ["discord", "https://discord.gg/orbit"],
      ["app_store", "https://apps.apple.com/app/id1"],
      ["google_play", "https://play.google.com/store/apps/details?id=x"],
      ["website", "https://orbit.example"],
      ["custom", "https://status.orbit.example"],
    ].map(([type, url]) => ({ type, label: type!, url }));
    expect(projectLinks.safeParse(links).success).toBe(true);
    expect(projectLinks.safeParse([...links, links[0]]).success).toBe(false);
  });
});
