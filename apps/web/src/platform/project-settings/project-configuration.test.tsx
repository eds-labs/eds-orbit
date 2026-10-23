import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as server from "../../../../../packages/schemas/src/project-settings";
import type { Project } from "@/lib/api";
import { labels, translate } from "@/lib/i18n";
import * as web from "./catalog";
import {
  addLanguage,
  cleanLinks,
  moveLink,
  removeLanguage,
  setDefaultLanguage,
} from "./editing";
import {
  ContentLanguagesPanel,
  ProfileLinksPanel,
  contentLanguageOptions,
  languagesOf,
} from "./project-configuration";
import { projectSettingsText } from "./texts";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  workspaceId: "w1",
  name: "Orbit",
  timezone: "Europe/Berlin",
  language: "de",
  contentLanguages: ["de", "en", "fr"],
  links: [],
  mode: "observe",
  paused: false,
  generation: 1,
  role: "owner",
  ...over,
});

describe("web catalog", () => {
  it("matches the server catalog", () => {
    expect(web.LANGUAGE_CODE_PATTERN.source).toBe(
      server.LANGUAGE_CODE_PATTERN.source,
    );
    expect(web.COMMON_CONTENT_LANGUAGES).toEqual(
      server.COMMON_CONTENT_LANGUAGES,
    );
    expect(web.AGENT_CONTENT_LANGUAGES).toEqual(server.AGENT_CONTENT_LANGUAGES);
    expect(web.PROJECT_LINK_TYPES).toEqual(server.PROJECT_LINK_TYPES);
    expect(web.MAX_CONTENT_LANGUAGES).toBe(server.MAX_CONTENT_LANGUAGES);
    expect(web.MAX_PROJECT_LINKS).toBe(server.MAX_PROJECT_LINKS);
    for (const raw of ["PT_br", "zh-hant", "EN"])
      expect(web.normalizeLanguageCode(raw)).toBe(
        server.normalizeLanguageCode(raw),
      );
    expect(Object.keys(web.LINK_TYPE_LABELS).sort()).toEqual(
      Object.keys(server.PROJECT_LINK_TYPES).sort(),
    );
  });

  it("names languages in the interface language", () => {
    expect(web.languageName("de", "en")).toBe("German");
    expect(web.languageName("de", "de")).toBe("Deutsch");
    expect(web.languageName("qqq", "en")).toBe("qqq");
  });

  it("flags link problems as the server would", () => {
    expect(
      web.linkProblems([
        { type: "x", label: "X", url: "https://x.com/orbit" },
        { type: "x", label: "", url: "https://x.com/a" },
        { type: "website", label: "Site", url: "nope" },
        { type: "website", label: "Site", url: "http://orbit.example" },
        { type: "tiktok", label: "TikTok", url: "https://instagram.com/orbit" },
        { type: "custom", label: "Again", url: "https://x.com/orbit" },
      ]),
    ).toEqual([
      null,
      "label_required",
      "url_invalid",
      "https_required",
      "host_mismatch",
      "duplicate",
    ]);
  });

  it("reads saved links defensively", () => {
    expect(
      web.projectLinksOf([
        { type: "mastodon", label: "Toot", url: "https://social.example/@o" },
        { type: "x", label: "X" },
        null,
      ]),
    ).toEqual([
      { type: "custom", label: "Toot", url: "https://social.example/@o" },
    ]);
    expect(web.projectLinksOf("nope")).toEqual([]);
  });
});

describe("editing steps", () => {
  const state = { languages: ["de", "en"], defaultLanguage: "de" };
  it("adds normalized codes and refuses invalid, duplicate and excess ones", () => {
    expect(addLanguage(state, "pt_br")).toEqual({
      ...state,
      languages: ["de", "en", "pt-BR"],
    });
    expect(addLanguage(state, "EN")).toEqual({ error: "duplicateLanguage" });
    expect(addLanguage(state, "klingon")).toEqual({ error: "invalidCode" });
    const full = {
      languages: web.COMMON_CONTENT_LANGUAGES.slice(0, 20),
      defaultLanguage: "en",
    };
    expect(addLanguage(full, "fil")).toEqual({ error: "tooManyLanguages" });
  });

  it("moves the default on removal and keeps one language", () => {
    expect(removeLanguage(state, "de")).toEqual({
      languages: ["en"],
      defaultLanguage: "en",
    });
    expect(
      removeLanguage({ languages: ["en"], defaultLanguage: "en" }, "en"),
    ).toEqual({
      error: "oneLanguageRequired",
    });
    expect(setDefaultLanguage(state, "en").defaultLanguage).toBe("en");
    expect(setDefaultLanguage(state, "fr")).toEqual(state);
  });

  it("reorders and trims links", () => {
    const links = [
      { type: "x" as const, label: "X ", url: " https://x.com/a" },
      { type: "website" as const, label: "Site", url: "https://a.example" },
    ];
    expect(moveLink(links, 1, -1).map((l) => l.type)).toEqual(["website", "x"]);
    expect(moveLink(links, 0, -1)).toEqual(links);
    expect(cleanLinks(links)[0]).toEqual({
      type: "x",
      label: "X",
      url: "https://x.com/a",
    });
  });
});

describe("project languages", () => {
  it("always contains the default, also for projects from before the list", () => {
    expect(
      languagesOf({ language: "de", contentLanguages: undefined }),
    ).toEqual(["de"]);
    expect(languagesOf({ language: "de", contentLanguages: ["en"] })).toEqual([
      "de",
      "en",
    ]);
  });

  it("offers the default first and keeps a record's own language", () => {
    const options = contentLanguageOptions(
      project({ contentLanguages: ["en", "de"] }),
      "en",
      "it",
    );
    expect(options.map((o) => o.value)).toEqual(["de", "en", "it"]);
    expect(options[0]!.label).toBe("German (de)");
  });
});

describe("panels", () => {
  it("shows the languages with the default and the agent note", () => {
    const html = renderToStaticMarkup(
      <ContentLanguagesPanel project={project()} isOwner locale="en" />,
    );
    expect(html).toContain("Content languages");
    expect(html).toContain("French");
    expect(html).toContain("Default");
    expect(html).toContain("English or German");
    expect(html).toContain("Edit");
  });

  it("switches its wording with the interface language, not the project", () => {
    const html = renderToStaticMarkup(
      <ContentLanguagesPanel
        project={project({ language: "en", contentLanguages: ["en"] })}
        isOwner={false}
        locale="de"
      />,
    );
    expect(html).toContain("Content-Sprachen");
    expect(html).toContain("Englisch");
    expect(html).toContain("Nur Owner");
    expect(html).not.toContain(">Bearbeiten<");
    // English and German only: no note about other languages.
    expect(html).not.toContain("Andere Sprachen stehen");
  });

  it("groups profile links and separates them from publishing channels", () => {
    const html = renderToStaticMarkup(
      <ProfileLinksPanel
        project={project({
          links: [
            {
              type: "instagram",
              label: "Instagram",
              url: "https://instagram.com/orbit",
            },
            {
              type: "app_store",
              label: "iOS app",
              url: "https://apps.apple.com/app/id1",
            },
            { type: "website", label: "Website", url: "https://orbit.example" },
          ],
        })}
        isOwner
        locale="en"
      />,
    );
    expect(html.indexOf("Web")).toBeLessThan(html.indexOf("Social media"));
    expect(html.indexOf("Social media")).toBeLessThan(
      html.indexOf("App stores"),
    );
    expect(html).toContain("never enables posting");
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("says when there are no links", () => {
    const html = renderToStaticMarkup(
      <ProfileLinksPanel project={project()} isOwner={false} locale="de" />,
    );
    expect(html).toContain("Noch keine Profil-Links.");
  });
});

describe("translations", () => {
  it("has a German label for every English one", () => {
    const missing = Object.keys(labels.en).filter(
      (key) => !(labels.de as Record<string, string>)[key],
    );
    expect(missing).toEqual([]);
  });

  it("falls back to English, then to the key", () => {
    expect(translate("de", "settings")).toBe("Einstellungen");
    const de = labels.de as Record<string, string>;
    const saved = de.settings;
    try {
      de.settings = "";
      expect(translate("de", "settings")).toBe("Settings");
    } finally {
      de.settings = saved!;
    }
    expect(projectSettingsText("de")("linksHeading")).toBe("Profil-Links");
    expect(projectSettingsText("en")("linksHeading")).toBe("Profile links");
  });
});
