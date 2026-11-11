"use client";
import { useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { Identity } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { Empty, Field, FieldLabel, Input } from "@/components/ui/primitives";
import { PageHead } from "@/platform/ui/collection";
import { SettingsNav, type SettingsGroup } from "@/platform/shell/settings-nav";
import type { Label } from "@/platform/shell/types";
import {
  navGroups,
  resolveSection,
  searchSections,
  sectionPath,
} from "./registry";
import { manageHref } from "./routes";
import { ScopeSwitcher } from "./scope-switcher";
import { centerText } from "./texts";
import type {
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
  ResolvedSection,
  SectionMeta,
} from "./types";

const keyOf = (section: SectionMeta) => sectionPath(section).join("/");

/**
 * The frame of the settings center: head, scope switcher and search, the
 * section list beside the content. Presentational only: the caller passes
 * the visible sections and the parsed address, and every navigation goes
 * through `navigate` or a plain link, so it renders without a router.
 */
export function SettingsCenterView({
  scope,
  scopeName,
  sections,
  target,
  caps,
  identity,
  locale,
  moduleName,
  navigate,
  backHref,
  backLabel,
}: {
  scope: ManageScope;
  scopeName: string;
  sections: readonly ResolvedSection[];
  target: ManageTarget;
  caps: ManagementCapabilities;
  identity: Identity;
  locale: Locale;
  moduleName(id: string): Label | undefined;
  navigate(href: string): void;
  backHref: string;
  backLabel: string;
}) {
  const t = centerText(locale);
  const [query, setQuery] = useState("");
  const hrefOf = (key: string) => manageHref(scope, ...key.split("/"));
  const groups = navGroups(sections, scope.kind, moduleName);
  const navList: SettingsGroup[] = groups.map((group) => ({
    id: group.id,
    label: group.label,
    tabs: group.sections.map((section) => ({
      key: keyOf(section),
      label: section.label,
      order: section.order,
      group: group.id,
    })),
  }));
  // A bare scope address shows the overview, so only an area resolves.
  const resolved =
    target.area === null
      ? null
      : resolveSection(sections, target.area, target.rest);
  const hits = searchSections(sections, query);

  const content = () => {
    if (query.trim() !== "") {
      return hits.length === 0 ? (
        <Empty title={t("searchEmpty")} />
      ) : (
        <ul className="manage-hits">
          {hits.map((section) => (
            <li key={keyOf(section)}>
              <Link href={hrefOf(keyOf(section))} onClick={() => setQuery("")}>
                <strong>{section.label[locale]}</strong>
                <span>{section.description[locale]}</span>
              </Link>
            </li>
          ))}
        </ul>
      );
    }
    if (resolved) {
      const { section, id } = resolved;
      const body = section.render({
        scope,
        id,
        locale,
        identity,
        hrefOf: (area, ...rest) => manageHref(scope, area, ...rest),
      });
      return (
        <>
          <PageHead
            as="h2"
            title={section.label[locale]}
            description={section.description[locale]}
          />
          {section.advanced ? (
            <details>
              <summary>{t("advanced")}</summary>
              {body}
            </details>
          ) : (
            body
          )}
        </>
      );
    }
    if (target.area === null) {
      return groups.length === 0 ? (
        <Empty title={t("notPermittedTitle")} />
      ) : (
        <>
          <p className="manage-hint">{t("overviewHint")}</p>
          <div className="manage-cards">
            {groups.map((group) => (
              <section className="panel manage-card" key={group.id}>
                <h2>
                  <Link href={hrefOf(keyOf(group.sections[0]))}>
                    {group.label[locale]}
                  </Link>
                </h2>
                <ul>
                  {group.sections.map((section) => (
                    <li key={keyOf(section)}>
                      <Link href={hrefOf(keyOf(section))}>
                        {section.label[locale]}
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      );
    }
    return (
      <Empty title={t("notPermittedTitle")} description={t("notPermittedBody")} />
    );
  };

  return (
    <>
      <Link className="back-link" href={backHref}>
        ← {backLabel}
      </Link>
      <div className="page-head">
        <div>
          <p className="page-eyebrow">{labels[locale].manageTitle}</p>
          <h1>{scopeName}</h1>
        </div>
      </div>
      <div className="manage-toolbar">
        <ScopeSwitcher
          caps={caps}
          current={scope}
          locale={locale}
          onSelect={navigate}
        />
        <Field>
          <FieldLabel htmlFor="manage-search">{t("searchLabel")}</FieldLabel>
          <div className="search-field">
            <Search aria-hidden="true" />
            <Input
              id="manage-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </Field>
      </div>
      <div className="admin-layout">
        <SettingsNav
          groups={navList}
          value={resolved ? keyOf(resolved.section) : ""}
          hrefOf={hrefOf}
          onSelect={(key) => navigate(hrefOf(key))}
          locale={locale}
        />
        <div className="settings-content">{content()}</div>
      </div>
    </>
  );
}
