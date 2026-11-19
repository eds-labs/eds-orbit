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
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { cmsPath, projectLocales, type CmsAuthor, type SiteList } from "./api";
import { cmsText, libraryError } from "./labels";

// Authors of the content module (ADR 0029 §5, CH1.14c): names, a short bio
// per language and profile links for the structured data (Person.sameAs).

/** The bio in the interface language, else the first one there is. */
export const bioOf = (author: Pick<CmsAuthor, "bio">, locale: string) =>
  author.bio?.[locale] || Object.values(author.bio ?? {}).find(Boolean) || null;

/** Profile links from a text area: trimmed, one per line, at most ten. */
export const parseLinks = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);

function AuthorForm({
  author,
  locales,
  onDone,
}: {
  author: CmsAuthor | null;
  locales: string[];
  onDone: (message: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = cmsText(locale).library;
  const a = t.authors;
  const [name, setName] = useState(author?.name ?? "");
  const [slug, setSlug] = useState(author?.slug ?? "");
  const [bio, setBio] = useState<Record<string, string>>(author?.bio ?? {});
  const [links, setLinks] = useState((author?.sameAs ?? []).join("\n"));
  const save = useMutation();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = {
      name: name.trim(),
      ...(slug.trim() ? { slug: slug.trim() } : {}),
      bio: Object.fromEntries(
        Object.entries(bio).filter(([, text]) => text.trim()),
      ),
      sameAs: parseLinks(links),
    };
    const done = await save.run(() =>
      author
        ? patch<CmsAuthor>(cmsPath(project.id, `/authors/${author.id}`), {
            version: author.version,
            ...body,
          })
        : post<CmsAuthor>(cmsPath(project.id, "/authors"), body),
    );
    if (done) onDone(author ? a.saved : a.created);
  };
  return (
    <form onSubmit={submit} className="cms-panel">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cms-author-name">{a.name}</FieldLabel>
          <Input
            id="cms-author-name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cms-author-slug">{a.slug}</FieldLabel>
          <Input
            id="cms-author-slug"
            maxLength={80}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
          />
        </Field>
        {locales.map((l) => (
          <Field key={l}>
            <FieldLabel htmlFor={`cms-author-bio-${l}`}>{a.bio(l)}</FieldLabel>
            <Textarea
              id={`cms-author-bio-${l}`}
              rows={3}
              maxLength={1000}
              value={bio[l] ?? ""}
              onChange={(e) => setBio({ ...bio, [l]: e.target.value })}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor="cms-author-links">{a.sameAs}</FieldLabel>
          <Textarea
            id="cms-author-links"
            rows={3}
            placeholder="https://…"
            value={links}
            onChange={(e) => setLinks(e.target.value)}
          />
        </Field>
      </FieldGroup>
      {save.error && <Alert kind="error">{libraryError(t, save.error)}</Alert>}
      <Button type="submit" disabled={save.pending || !name.trim()}>
        {author ? a.save : a.create}
      </Button>
    </form>
  );
}

export function AuthorsView() {
  const { project, locale, canEdit } = useWorkspace();
  const t = cmsText(locale).library;
  const a = t.authors;
  const sites = useResource<SiteList>(cmsPath(project.id, "/sites"));
  const locales = projectLocales(
    sites.data?.items ?? [],
    project.contentLanguages ?? [project.language],
  );
  const authors = useResource<{ items: CmsAuthor[] }>(
    cmsPath(project.id, "/authors?archived=true"),
  );
  const [editing, setEditing] = useState<CmsAuthor | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const archive = useMutation();
  const toggleArchive = async (author: CmsAuthor) => {
    const done = await archive.run(() =>
      post(
        cmsPath(
          project.id,
          `/authors/${author.id}/${author.archived ? "unarchive" : "archive"}`,
        ),
        {
          version: author.version,
        },
      ),
    );
    if (done) authors.refresh();
  };
  return (
    <div className="support-page">
      <PageHead title={a.title} description={a.intro}>
        {canEdit && <Button onClick={() => setEditing("new")}>{a.new}</Button>}
      </PageHead>
      {notice && <Alert kind="success">{notice}</Alert>}
      {archive.error && (
        <Alert kind="error">{libraryError(t, archive.error)}</Alert>
      )}
      <ResourceError error={authors.error} retry={authors.refresh} />
      {authors.data &&
        (authors.data.items.length ? (
          <ul className="cms-author-list">
            {authors.data.items.map((author) => (
              <li key={author.id} className="cms-author">
                <div>
                  <strong>{author.name}</strong>{" "}
                  <code className="field-hint">{author.slug}</code>{" "}
                  {author.archived && <Badge>{a.archivedBadge}</Badge>}
                  {bioOf(author, locale) && (
                    <p className="field-hint">{bioOf(author, locale)}</p>
                  )}
                </div>
                {canEdit && (
                  <div className="cms-actions">
                    {!author.archived && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing(author)}
                      >
                        {a.edit}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={archive.pending}
                      onClick={() => void toggleArchive(author)}
                    >
                      {author.archived ? a.unarchive : a.archive}
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={a.empty} />
        ))}
      {editing && (
        <Modal
          title={editing === "new" ? a.new : editing.name}
          onClose={() => setEditing(null)}
        >
          <AuthorForm
            author={editing === "new" ? null : editing}
            locales={locales}
            onDone={(message) => {
              setNotice(message);
              setEditing(null);
              authors.refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
