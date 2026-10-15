"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Button, Textarea } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead } from "@/platform/ui/collection";
import { storeAssistantDraft } from "./assistant-draft";
import { useShell } from "./shell-context";

/**
 * The project home (WP1.7): the assistant prompt, one tile per enabled
 * module with its pages, then the sections the modules contribute.
 */
export function ProjectHome() {
  const { project, t, locale } = useWorkspace();
  const shell = useShell();
  const platformPages = shell.platformNav.filter((r) => r.segments.length);
  const tiles = [
    ...shell.modules
      .filter((m) => m.enabled && m.nav.length)
      .map((m) => ({
        id: m.id,
        name: m.displayName[locale],
        description: m.description[locale],
        pages: m.nav,
      })),
    {
      id: "platform",
      name: t("projectArea"),
      description: t("projectAreaHint"),
      pages: platformPages,
    },
  ];
  return (
    <div className="project-home">
      <PageHead title={project.name} description={t("homeSubtitle")} />
      <AssistantPrompt />
      <section className="home-modules" aria-labelledby="home-modules">
        <h2 id="home-modules" className="sr-only">
          {t("modules")}
        </h2>
        <ul className="module-tiles">
          {tiles.map((tile) => (
            <li key={tile.id} className="module-tile" data-module={tile.id}>
              <h3>{tile.name}</h3>
              <p>{tile.description}</p>
              <ul>
                {tile.pages.map(({ key, nav }) => {
                  const Icon = nav!.icon;
                  return (
                    <li key={key}>
                      <Link href={shell.hrefOf(key)}>
                        <Icon aria-hidden="true" />
                        <span>{nav!.label[locale]}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      {shell.homeSections.map(({ moduleId, component: Section }) => (
        <div key={moduleId} className="home-section" data-module={moduleId}>
          <Section />
        </div>
      ))}
    </div>
  );
}

function AssistantPrompt() {
  const { project, t } = useWorkspace();
  const shell = useShell();
  const router = useRouter();
  const [text, setText] = useState("");
  return (
    <form
      className="panel assistant-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim()) return;
        storeAssistantDraft(project.id, text.trim());
        router.push(shell.hrefOf("chat"));
      }}
    >
      <div className="panel-head">
        <h2>
          <MessageCircle aria-hidden="true" />
          {t("askAssistant")}
        </h2>
      </div>
      <label htmlFor="home-assistant-input" className="sr-only">
        {t("askAssistantLabel")}
      </label>
      <Textarea
        id="home-assistant-input"
        rows={2}
        maxLength={4000}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="assistant-prompt-actions">
        <p>{t("askAssistantHint")}</p>
        <Button type="submit" disabled={!text.trim()}>
          {t("continueInChat")}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </form>
  );
}
