"use client";
import Link from "next/link";
import { ArrowRight, Building2, FolderOpen } from "lucide-react";
import type { Identity } from "@/lib/api";
import type { Locale, Text } from "@/lib/i18n";
import {
  COMMON_CONTENT_LANGUAGES,
  languageName,
} from "@/platform/project-settings/catalog";
import { Badge, Empty } from "@/components/ui/primitives";
import { DataForm, type FormField, type FormValues } from "@/platform/ui/form";
import { NotFound } from "./not-found";

// The organization and project pickers (WP1.7). An organization is a
// workspace on the server; the UI says "organization" (ADR 0009).

export function OrganizationPicker({
  identity,
  t,
}: {
  identity: Identity;
  t: Text;
}) {
  return (
    <section className="picker" aria-labelledby="picker-title">
      <h1 id="picker-title">{t("chooseOrganization")}</h1>
      <p>{t("chooseOrganizationHint")}</p>
      <ul className="picker-list">
        {identity.workspaces.map((w) => {
          const count = identity.projects.filter(
            (p) => p.workspaceId === w.id,
          ).length;
          return (
            <li key={w.id}>
              <Link href={`/o/${encodeURIComponent(w.id)}`}>
                <Building2 aria-hidden="true" />
                <span className="picker-label">
                  <strong>{w.name}</strong>
                  <small>
                    {t("projects")}: {count}
                  </small>
                </span>
                {w.role && <Badge>{w.role}</Badge>}
                <ArrowRight aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ProjectPicker({
  identity,
  organizationId,
  t,
  locale = "en",
  create,
}: {
  identity: Identity;
  organizationId: string;
  t: Text;
  locale?: Locale;
  create: {
    onSubmit: (values: FormValues, workspaceId: string) => Promise<void>;
    pending: boolean;
    error: string | null;
  };
}) {
  const organization = identity.workspaces.find((w) => w.id === organizationId);
  if (!organization) return <NotFound t={t} />;
  const projects = identity.projects.filter(
    (p) => p.workspaceId === organization.id,
  );
  const isOwner = organization.role === "owner";
  return (
    <section className="picker" aria-labelledby="picker-title">
      {identity.workspaces.length > 1 && (
        <Link className="text-link" href="/o">
          {t("switchOrganization")}
        </Link>
      )}
      <h1 id="picker-title">{t("chooseProject")}</h1>
      <p>
        {organization.name} · {t("chooseProjectHint")}
      </p>
      {projects.length ? (
        <ul className="picker-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link href={`/p/${encodeURIComponent(p.id)}`}>
                <FolderOpen aria-hidden="true" />
                <span className="picker-label">
                  <strong>{p.name}</strong>
                  <small>{p.timezone}</small>
                </span>
                {p.role && <Badge>{p.role}</Badge>}
                <ArrowRight aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        !isOwner && (
          <Empty
            icon={FolderOpen}
            title={t("noProjects")}
            description={t("noProjectsHint")}
          />
        )
      )}
      {isOwner && (
        <div className="picker-create">
          <h2>{t("newProject")}</h2>
          <DataForm
            fields={projectFields(t, locale)}
            onSubmit={(values) => create.onSubmit(values, organization.id)}
            pending={create.pending}
            error={create.error}
            submitLabel={t("create")}
            t={t}
          />
        </div>
      )}
    </section>
  );
}

export function projectFields(t: Text, locale: Locale = "en"): FormField[] {
  return [
    { name: "name", label: t("name"), required: true },
    {
      name: "timezone",
      label: t("timezone"),
      value: Intl.DateTimeFormat().resolvedOptions().timeZone,
      required: true,
    },
    {
      name: "language",
      label: t("defaultContentLanguage"),
      type: "select",
      value: "en",
      options: COMMON_CONTENT_LANGUAGES.map((code) => ({
        value: code,
        label: `${languageName(code, locale)} (${code})`,
      })).sort((a, b) => a.label.localeCompare(b.label, locale)),
      hint: t("defaultContentLanguageHint"),
      required: true,
    },
  ];
}
