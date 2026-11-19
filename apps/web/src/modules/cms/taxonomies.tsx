"use client";
import { useState, type FormEvent } from "react";
import { patch, post, useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Modal,
  Tabs,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cmsPath, projectLocales, type CmsTerm, type SiteList } from "./api";
import { cmsText, libraryError } from "./labels";

// Categories and tags of the content module (ADR 0029 §5, CH1.14c). Terms
// exist per language; a translation joins another term's group so websites
// can link the language versions. Archived terms stay on the entries that
// name them but cannot be chosen again.

type Kind = CmsTerm["kind"];

/** Categories ordered as a tree (parents before children), with their depth. */
export function termTree(terms: CmsTerm[]) {
  const byParent = new Map<string | null, CmsTerm[]>();
  const ids = new Set(terms.map((t) => t.id));
  for (const term of terms) {
    const parent =
      term.parentId && ids.has(term.parentId) ? term.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), term]);
  }
  const out: Array<{ term: CmsTerm; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const term of (byParent.get(parent) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      out.push({ term, depth });
      if (depth < 5) walk(term.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function TermForm({
  kind,
  termLocale,
  locales,
  terms,
  term,
  onDone,
}: {
  kind: Kind;
  termLocale: string;
  locales: string[];
  terms: CmsTerm[];
  term: CmsTerm | null;
  onDone: (message: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).library;
  const s = t.terms;
  const [name, setName] = useState(term?.name ?? "");
  const [slug, setSlug] = useState(term?.slug ?? "");
  const [description, setDescription] = useState(term?.description ?? "");
  const [parentId, setParentId] = useState(term?.parentId ?? "");
  const [language, setLanguage] = useState(term?.locale ?? termLocale);
  const [translationOf, setTranslationOf] = useState("");
  const save = useMutation();
  const parents = terms.filter(
    (other) =>
      other.kind === "category" &&
      other.locale === language &&
      !other.archived &&
      other.id !== term?.id,
  );
  // Terms of the same kind in other languages this new term can translate.
  const sources = terms.filter(
    (other) =>
      other.kind === kind && other.locale !== language && !other.archived,
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const common = {
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      description: description.trim() || null,
      ...(kind === "category" ? { parentId: parentId || null } : {}),
    };
    const done = await save.run(() =>
      term
        ? patch<CmsTerm>(cmsPath(project.id, `/terms/${term.id}`), {
            version: term.version,
            ...common,
          })
        : post<CmsTerm>(cmsPath(project.id, "/terms"), {
            kind,
            locale: language,
            ...common,
            ...(translationOf ? { translationOf } : {}),
          }),
    );
    if (done) onDone(term ? s.saved : s.created);
  };
  return (
    <form onSubmit={submit} className="cms-panel">
      <FieldGroup>
        {!term && (
          <Field>
            <FieldLabel htmlFor="cms-term-locale">{s.language}</FieldLabel>
            <select
              id="cms-term-locale"
              className="input"
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setParentId("");
                setTranslationOf("");
              }}
            >
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="cms-term-name">{s.name}</FieldLabel>
          <Input
            id="cms-term-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-term-slug">{s.slug}</FieldLabel>
          <Input
            id="cms-term-slug"
            maxLength={80}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-term-description">
            {s.description}
          </FieldLabel>
          <Textarea
            id="cms-term-description"
            rows={2}
            maxLength={1000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        {kind === "category" && (
          <Field>
            <FieldLabel htmlFor="cms-term-parent">{s.parent}</FieldLabel>
            <select
              id="cms-term-parent"
              className="input"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">{s.noParent}</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!term && sources.length > 0 && (
          <Field>
            <FieldLabel htmlFor="cms-term-translation">
              {s.translationOf}
            </FieldLabel>
            <select
              id="cms-term-translation"
              className="input"
              value={translationOf}
              onChange={(e) => setTranslationOf(e.target.value)}
            >
              <option value="">{s.noTranslation}</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name} ({source.locale})
                </option>
              ))}
            </select>
          </Field>
        )}
      </FieldGroup>
      {save.error && <Alert kind="error">{libraryError(t, save.error)}</Alert>}
      <Button type="submit" disabled={save.pending || !name.trim()}>
        {term ? s.save : s.create}
      </Button>
    </form>
  );
}

export function TaxonomiesView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = cmsText(locale).library;
  const s = t.terms;
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const locales = projectLocales(
    sites.data?.items ?? [],
    project.contentLanguages ?? [project.language],
  );
  const [kind, setKind] = useState<Kind>("category");
  const [chosen, setChosen] = useState<string | null>(null);
  const termLocale = chosen ?? locales[0] ?? "de";
  const terms = useResource<{ items: CmsTerm[] }>(
    cmsPath(project.id, "/terms?archived=true"),
  );
  const [editing, setEditing] = useState<CmsTerm | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const archive = useMutation();
  const all = terms.data?.items ?? [];
  const shown = all.filter(
    (term) => term.kind === kind && term.locale === termLocale,
  );
  const rows =
    kind === "category"
      ? termTree(shown)
      : shown.map((term) => ({ term, depth: 0 }));
  const toggleArchive = async (term: CmsTerm) => {
    const done = await archive.run(() =>
      post(
        cmsPath(
          project.id,
          `/terms/${term.id}/${term.archived ? "unarchive" : "archive"}`,
        ),
        {
          version: term.version,
        },
      ),
    );
    if (done) terms.refresh();
  };
  return (
    <div className="support-page">
      <PageHead title={s.title} description={s.intro}>
        {canEdit && <Button onClick={() => setEditing("new")}>{s.new}</Button>}
      </PageHead>
      <Tabs
        tabs={[
          { key: "category", label: s.categories },
          { key: "tag", label: s.tags },
        ]}
        value={kind}
        onChange={(key) => setKind(key as Kind)}
      />
      <div className="filter-bar">
        <select
          aria-label={s.language}
          className="input"
          value={termLocale}
          onChange={(e) => setChosen(e.target.value)}
        >
          {locales.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {notice && <Alert kind="success">{notice}</Alert>}
      {archive.error && (
        <Alert kind="error">{libraryError(t, archive.error)}</Alert>
      )}
      <ResourceError error={terms.error} retry={terms.refresh} />
      {terms.data &&
        (rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{s.name}</th>
                  <th scope="col">Slug</th>
                  <th scope="col">
                    <span className="sr-only">{s.edit}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ term, depth }) => (
                  <tr key={term.id}>
                    <td>
                      <span style={{ paddingInlineStart: `${depth * 18}px` }}>
                        {depth > 0 && "↳ "}
                        {term.name}
                      </span>{" "}
                      {term.archived && <Badge>{s.archivedBadge}</Badge>}
                      {term.description && (
                        <p className="field-hint">{term.description}</p>
                      )}
                    </td>
                    <td>
                      <code>{term.slug}</code>
                    </td>
                    <td>
                      {canEdit && (
                        <div className="cms-actions">
                          {!term.archived && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditing(term)}
                            >
                              {s.edit}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={archive.pending}
                            onClick={() => void toggleArchive(term)}
                          >
                            {term.archived ? s.unarchive : s.archive}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={s.empty} />
        ))}
      {editing && (
        <Modal
          title={editing === "new" ? s.new : editing.name}
          description={kind === "category" ? s.categories : s.tags}
          onClose={() => setEditing(null)}
        >
          <TermForm
            kind={editing === "new" ? kind : editing.kind}
            termLocale={termLocale}
            locales={locales}
            terms={all}
            term={editing === "new" ? null : editing}
            onDone={(message) => {
              setNotice(message);
              setEditing(null);
              terms.refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
