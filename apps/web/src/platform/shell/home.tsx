"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleCheck } from "lucide-react";
import type { AttentionResponse } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { Button, Empty, Input, Skeleton } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { ResourceError } from "@/platform/ui/collection";
import { storeAssistantDraft } from "./assistant-draft";
import { useAttention } from "./attention";
import { AttentionList } from "./attention-list";
import { useShell } from "./shell-context";

// The project home (UI restructure §5.1): a greeting with what needs the
// member today, the assistant prompt, the status strip, the attention items
// of every module, then the sections the modules contribute.

/** At most this many attention rows until "Show all". */
const ROWS = 8;

/** "Guten Morgen" before 11:00, "Guten Tag" before 18:00, else "Guten Abend". */
export function greeting(date: Date, locale: Locale): string {
  const hour = date.getHours();
  const key = hour < 11 ? "morning" : hour < 18 ? "day" : "evening";
  return {
    morning: { en: "Good morning", de: "Guten Morgen" },
    day: { en: "Good afternoon", de: "Guten Tag" },
    evening: { en: "Good evening", de: "Guten Abend" },
  }[key][locale];
}

/**
 * Hands the prompt to Orbit Chat without sending it: stores it as the
 * chat's draft and opens the chat. False for an empty prompt.
 */
export function submitAssistantPrompt(
  projectId: string,
  text: string,
  chatHref: string,
  push: (href: string) => void,
): boolean {
  const draft = text.trim();
  if (!draft) return false;
  storeAssistantDraft(projectId, draft);
  push(chatHref);
  return true;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

export function ProjectHome() {
  const { identity, locale, t, refresh } = useWorkspace();
  const shell = useShell();
  const attention = useAttention();
  const now = new Date();
  const name = identity.user.name?.trim().split(/\s+/)[0];
  const hello = greeting(now, locale);
  const data = attention.error ? undefined : attention.data;
  const pressing = data?.items.filter(
    (item) => item.severity === "critical" || item.severity === "warning",
  ).length;
  const subtitle = [
    new Intl.DateTimeFormat(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(now),
    pressing === 1
      ? t("attentionCountOne")
      : pressing
        ? fill(t("attentionCount"), { n: String(pressing) })
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="project-home">
      <div className="home-head">
        <div>
          <h1>{name ? `${hello}, ${name}` : hello}</h1>
          <p>{subtitle}</p>
        </div>
        <AssistantPrompt />
      </div>
      {data && <StatusStrip status={data.status} now={now} />}
      <section
        className="panel attention-panel"
        aria-labelledby="home-attention"
        aria-busy={attention.loading && !data ? true : undefined}
      >
        <div className="panel-head">
          <h2 id="home-attention">{t("attentionTitle")}</h2>
          <p>{t("attentionHint")}</p>
        </div>
        {attention.error ? (
          <div className="attention-error">
            <ResourceError
              error={
                attention.error instanceof Error
                  ? attention.error
                  : new Error(String(attention.error))
              }
              retry={refresh}
            />
          </div>
        ) : data ? (
          data.items.length ? (
            <AttentionList items={data.items} max={ROWS} now={now} />
          ) : (
            <Empty title={t("allClear")} icon={CircleCheck} />
          )
        ) : (
          <ul className="attention-list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="attention-placeholder">
                <Skeleton />
              </li>
            ))}
          </ul>
        )}
      </section>
      {shell.homeSections.map(({ moduleId, component: Section }) => (
        <div key={moduleId} className="home-section" data-module={moduleId}>
          <Section />
        </div>
      ))}
    </div>
  );
}

/** Whether the project is paused, its marketing mode and the AI budget. */
export function StatusStrip({
  status,
  now,
}: {
  status: AttentionResponse["status"];
  now: Date;
}) {
  const { locale, t } = useWorkspace();
  const shell = useShell();
  const modes: Record<string, string> = {
    observe: t("observe"),
    assisted: t("modeAssisted"),
    autopilot: t("modeAutopilot"),
  };
  const state = status.paused
    ? t("paused")
    : status.mode
      ? (modes[status.mode] ?? status.mode)
      : t("statusActive");
  // The budget counts the UTC calendar month (attention status.aiMonth).
  const month = new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
  }).format(now);
  const amount = (micros: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(micros / 1_000_000);
  const { spentMicros, limitMicros } = status.aiMonth;
  const budget =
    limitMicros === null
      ? fill(t("aiBudgetLineNoLimit"), { month, spent: amount(spentMicros) })
      : fill(t("aiBudgetLine"), {
          month,
          spent: amount(spentMicros),
          limit: amount(limitMicros),
        });
  return (
    <div className="status-strip" data-paused={String(status.paused)}>
      <strong className="status-strip-state">
        <span className="status-strip-dot" aria-hidden="true" />
        {state}
      </strong>
      <span>{budget}</span>
      <Link className="status-strip-link" href={shell.hrefOf("operations")}>
        {t("operationsLink")}
      </Link>
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
      className="home-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        submitAssistantPrompt(project.id, text, shell.hrefOf("chat"), (href) =>
          router.push(href),
        );
      }}
    >
      <label htmlFor="home-assistant-input" className="sr-only">
        {t("askAssistantLabel")}
      </label>
      <Input
        id="home-assistant-input"
        maxLength={4000}
        placeholder={t("askPlaceholder")}
        aria-describedby="home-assistant-hint"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        type="submit"
        size="icon"
        aria-label={t("continueInChat")}
        disabled={!text.trim()}
      >
        <ArrowRight aria-hidden="true" />
      </Button>
      <p id="home-assistant-hint" className="sr-only">
        {t("askAssistantHint")}
      </p>
    </form>
  );
}
