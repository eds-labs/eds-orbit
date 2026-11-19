"use client";
import { useMemo, useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { post, useMutation, useResource, when } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  cmsPath,
  type EntryDetail,
  type EntryList,
  type EntryStatus,
  type Preflight,
  type SiteList,
} from "./api";
import { cmsText } from "./labels";

// The content entries (ADR 0029 §5, CH1.14a): a filtered list, a form for a
// new article and, per entry (`?entry=<id>`), its state: live and latest
// version, an open decision, translations and what would stop publishing.
// The editor itself follows with CH1.14b.

const STATUS_TONE: Record<
  EntryStatus,
  "neutral" | "success" | "warning" | "blue"
> = {
  draft: "neutral",
  in_review: "warning",
  scheduled: "blue",
  published: "success",
  archived: "neutral",
};

/** The query string of the list for the chosen filters. */
export function listQuery(
  filters: { status: string; locale: string; q: string },
  cursor?: string | null,
) {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.locale) params.set("locale", filters.locale);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (cursor) params.set("cursor", cursor);
  const text = params.toString();
  return text ? `?${text}` : "";
}

function NewArticle({
  sites,
  onCreated,
}: {
  sites: SiteList["items"];
  onCreated: (id: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).entries;
  const locales = useMemo(
    () => [...new Set(sites.flatMap((s) => s.locales))].sort(),
    [sites],
  );
  const [title, setTitle] = useState("");
  const [entryLocale, setEntryLocale] = useState(locales[0] ?? "de");
  const serving = sites.filter((s) => s.locales.includes(entryLocale));
  const [chosen, setChosen] = useState<string[]>([]);
  const create = useMutation();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = await create.run(() =>
      post<{ entry: { id: string } }>(cmsPath(project.id, "/entries"), {
        type: "article",
        locale: entryLocale,
        title: title.trim(),
        siteIds: chosen.filter((id) => serving.some((s) => s.id === id)),
      }),
    );
    if (result) onCreated(result.entry.id);
  };
  return (
    <form onSubmit={submit} aria-labelledby="cms-new-article">
      <h2 id="cms-new-article">{t.newArticle}</h2>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cms-new-title">{t.titleLabel}</FieldLabel>
          <Input
            id="cms-new-title"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-new-locale">{t.localeLabel}</FieldLabel>
          <select
            id="cms-new-locale"
            className="input"
            value={entryLocale}
            onChange={(e) => setEntryLocale(e.target.value)}
          >
            {(locales.length ? locales : ["de", "en"]).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <fieldset>
          <legend>{t.sitesLabel}</legend>
          {serving.length ? (
            serving.map((s) => (
              <label key={s.id} className="check-row">
                <input
                  type="checkbox"
                  checked={chosen.includes(s.id)}
                  onChange={(e) =>
                    setChosen(
                      e.target.checked
                        ? [...chosen, s.id]
                        : chosen.filter((id) => id !== s.id),
                    )
                  }
                />{" "}
                {s.name} <span className="field-hint">{s.baseUrl}</span>
              </label>
            ))
          ) : (
            <p className="field-hint">{t.noSites}</p>
          )}
        </fieldset>
      </FieldGroup>
      {create.error && <Alert kind="error">{create.error}</Alert>}
      <Button type="submit" disabled={create.pending || !title.trim()}>
        {t.create}
      </Button>
    </form>
  );
}

function EntryListView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = cmsText(locale);
  const router = useRouter();
  const pathname = usePathname();
  const [filters, setFilters] = useState({ status: "", locale: "", q: "" });
  const [applied, setApplied] = useState(filters);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useResource<EntryList>(
    cmsPath(project.id, `/entries${listQuery(applied, cursor)}`),
  );
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const filtered = Boolean(
    applied.status || applied.locale || applied.q.trim(),
  );
  const locales = [
    ...new Set((sites.data?.items ?? []).flatMap((s) => s.locales)),
  ].sort();
  return (
    <div className="support-page">
      <PageHead title={t.entries.title} description={t.entries.intro} />
      <form
        className="filter-bar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(null);
          setApplied(filters);
        }}
      >
        <select
          aria-label={t.entries.filterStatus}
          className="input"
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
        >
          <option value="">{t.entries.all}</option>
          {(Object.keys(t.status) as EntryStatus[]).map((s) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </select>
        <select
          aria-label={t.entries.filterLocale}
          className="input"
          value={filters.locale}
          onChange={(e) => setFilters({ ...filters, locale: e.target.value })}
        >
          <option value="">{t.entries.allLocales}</option>
          {locales.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <div className="search-field">
          <Search aria-hidden="true" />
          <Input
            type="search"
            aria-label={t.entries.search}
            placeholder={t.entries.search}
            value={filters.q}
            maxLength={100}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </div>
        <Button type="submit" variant="outline">
          {t.entries.search}
        </Button>
      </form>
      <ResourceError error={list.error} retry={list.refresh} />
      {list.data &&
        (list.data.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t.entries.titleLabel}</th>
                  <th scope="col">{t.entries.filterStatus}</th>
                  <th scope="col">{t.entries.localeLabel}</th>
                  <th scope="col">{t.entries.updated}</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <a href={`?entry=${item.id}`}>
                        <strong>{item.title || t.entries.untitled}</strong>
                      </a>
                      {item.excerpt && (
                        <p className="field-hint">{item.excerpt}</p>
                      )}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[item.status]}>
                        {t.status[item.status]}
                      </Badge>{" "}
                      {item.pendingRequest && (
                        <Badge tone="warning">{t.entries.waiting}</Badge>
                      )}
                    </td>
                    <td>{item.locale}</td>
                    <td>{when(item.updatedAt, locale, project.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={filtered ? t.entries.empty : t.entries.emptyAll} />
        ))}
      {list.data?.nextCursor && (
        <Button
          variant="outline"
          onClick={() => setCursor(list.data!.nextCursor)}
        >
          {t.entries.more}
        </Button>
      )}
      {canEdit && sites.data && (
        <NewArticle
          sites={sites.data.items}
          onCreated={(id) => router.push(`${pathname}?entry=${id}`)}
        />
      )}
    </div>
  );
}

function EntryPage({ entryId }: { entryId: string }) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale);
  const detail = useResource<EntryDetail>(
    cmsPath(project.id, `/entries/${entryId}`),
  );
  const checks = useResource<Preflight>(
    cmsPath(project.id, `/entries/${entryId}/preflight`),
  );
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const d = detail.data;
  const siteName = (id: string) =>
    sites.data?.items.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="support-page">
      <PageHead
        title={d?.draft.title || t.entries.untitled}
        description={t.entries.intro}
      >
        <a className="button button-outline" href="?">
          {t.entries.back}
        </a>
      </PageHead>
      <ResourceError error={detail.error} retry={detail.refresh} />
      {d && (
        <>
          <p>
            <Badge tone={STATUS_TONE[d.entry.status]}>
              {t.status[d.entry.status]}
            </Badge>{" "}
            {d.pendingRequest && (
              <Badge tone="warning">{t.entries.waiting}</Badge>
            )}{" "}
            <span className="field-hint">{d.entry.locale}</span>
          </p>
          <dl className="detail-grid">
            <dt>{t.entries.live}</dt>
            <dd>
              {d.publishedRevision
                ? `#${d.publishedRevision.number} · ${when(d.entry.lastPublishedAt, locale, project.timezone)}`
                : t.entries.noLive}
            </dd>
            <dt>{t.entries.latest}</dt>
            <dd>
              {d.latestRevision
                ? `#${d.latestRevision.number} · ${when(d.latestRevision.createdAt, locale, project.timezone)}`
                : "—"}
            </dd>
            {d.entry.scheduledAt && (
              <>
                <dt>{t.entries.scheduledFor}</dt>
                <dd>{when(d.entry.scheduledAt, locale, project.timezone)}</dd>
              </>
            )}
            <dt>{t.entries.sitesLabel}</dt>
            <dd>
              {d.siteIds.length ? d.siteIds.map(siteName).join(", ") : "—"}
            </dd>
            <dt>{t.entries.translations}</dt>
            <dd>
              {d.translations.length
                ? d.translations.map((tr, i) => (
                    <span key={tr.id}>
                      {i > 0 && ", "}
                      <a href={`?entry=${tr.id}`}>{tr.locale}</a> (
                      {t.status[tr.status]})
                    </span>
                  ))
                : "—"}
            </dd>
          </dl>
          {d.unsavedChanges && (
            <p className="field-hint">{t.entries.unsaved}</p>
          )}
          {d.draft.excerpt && <p>{d.draft.excerpt}</p>}
          <section aria-labelledby="cms-preflight">
            <h2 id="cms-preflight">{t.entries.preflightTitle}</h2>
            <ResourceError error={checks.error} retry={checks.refresh} />
            {checks.data &&
              (checks.data.ok ? (
                <p>{t.entries.preflightOk}</p>
              ) : (
                <ul>
                  {checks.data.issues.map((issue, i) => (
                    <li key={`${issue.code}-${i}`}>
                      {t.entries.issue[issue.code] ??
                        `${t.entries.issueOther} (${issue.code})`}
                      {issue.siteId && (
                        <span className="field-hint">
                          {" "}
                          · {siteName(issue.siteId)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ))}
          </section>
          <p className="field-hint">{t.entries.editorSoon}</p>
        </>
      )}
    </div>
  );
}

export function EntriesView() {
  const params = useSearchParams();
  const entryId = params?.get("entry") ?? null;
  return entryId ? <EntryPage entryId={entryId} /> : <EntryListView />;
}
