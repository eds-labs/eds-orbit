"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import type { Identity } from "@/lib/api";
import { labels, type Locale } from "@/lib/i18n";
import { Empty, Field, FieldLabel, Input } from "@/components/ui/primitives";
import { PageHead, PageHeadLevel } from "@/platform/ui/collection";
import { SettingsNav, type SettingsGroup } from "@/platform/shell/settings-nav";
import type { Label } from "@/platform/shell/types";
import {
  navGroups,
  resolveSection,
  searchSections,
  sectionPath,
} from "./registry";
import { manageHref, scopeKey } from "./routes";
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

/** A stable key of the open address: scope, area and the path below it. */
export function addressKey(target: ManageTarget): string {
  return JSON.stringify([
    target.scope ? scopeKey(target.scope) : null,
    target.area,
    target.rest,
  ]);
}

/**
 * The search is tied to the address it was typed on, so it ends on every
 * change of address, whichever link, select or browser button caused it.
 */
export function activeQuery(
  search: { query: string; at: string },
  address: string,
): string {
  return search.at === address && search.query.trim() !== "" ? search.query : "";
}

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
  notices,
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
  /** Shown above whatever the content column holds, e.g. a module's load error. */
  notices?: ReactNode;
}) {
  const t = centerText(locale);
  const at = addressKey(target);
  const [search, setSearch] = useState({ query: "", at });
  const query = activeQuery(search, at);
  // A link to the address that is already open changes nothing, so every
  // navigation also ends the search itself.
  const endSearch = () => setSearch({ query: "", at });
  const go = (href: string) => {
    endSearch();
    navigate(href);
  };
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
    if (query !== "") {
      return hits.length === 0 ? (
        <Empty title={t("searchEmpty")} />
      ) : (
        <ul className="manage-hits">
          {hits.map((section) => (
            <li key={keyOf(section)}>
              <Link href={hrefOf(keyOf(section))} onClick={endSearch}>
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
          {!section.ownHead && (
            <PageHead
              as="h2"
              title={section.label[locale]}
              description={section.description[locale]}
            />
          )}
          {/* Mounted views keep their own PageHead, one level below the scope's h1. */}
          <PageHeadLevel.Provider value="h2">
            {section.advanced ? (
              <details>
                <summary>{t("advanced")}</summary>
                {body}
              </details>
            ) : (
              body
            )}
          </PageHeadLevel.Provider>
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
                  <Link href={hrefOf(keyOf(group.sections[0]))} onClick={endSearch}>
                    {group.label[locale]}
                  </Link>
                </h2>
                <ul>
                  {group.sections.map((section) => (
                    <li key={keyOf(section)}>
                      <Link href={hrefOf(keyOf(section))} onClick={endSearch}>
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
      <Link className="back-link" href={backHref} onClick={endSearch}>
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
          onSelect={go}
        />
        <Field>
          <FieldLabel htmlFor="manage-search">{t("searchLabel")}</FieldLabel>
          <div className="search-field">
            <Search aria-hidden="true" />
            <Input
              id="manage-search"
              type="search"
              // The raw text, so typing a leading space is not swallowed.
              value={search.at === at ? search.query : ""}
              onChange={(e) => setSearch({ query: e.target.value, at })}
            />
          </div>
        </Field>
      </div>
      <div className="admin-layout">
        <SettingsNav
          groups={navList}
          value={resolved ? keyOf(resolved.section) : ""}
          hrefOf={hrefOf}
          onSelect={(key) => go(hrefOf(key))}
          locale={locale}
        />
        <div className="settings-content">
          {notices}
          {content()}
        </div>
      </div>
    </>
  );
}
