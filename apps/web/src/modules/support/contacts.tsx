"use client";
import { useState } from "react";
import { useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Button,
  Empty,
  Input,
  Loading,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import { patch, post, supportPath, type Contact } from "./api";
import { supportText } from "./labels";

/** Support contacts: search, details with tickets, edit and merge. */
export function SupportContacts() {
  const { project, locale, canEdit } = useWorkspace();
  const t = supportText(locale);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useResource<{ items: Contact[] }>(
    supportPath(
      project.id,
      `/contacts${search ? `?q=${encodeURIComponent(search)}` : ""}`,
    ),
  );
  return (
    <div className="support-page">
      <PageHead title={t.contacts} description={t.contactsIntro} />
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q.trim());
        }}
      >
        <Input
          aria-label={t.search}
          placeholder={t.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </form>
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ResourceError error={list.error} retry={list.refresh} />
      ) : !list.data?.items.length ? (
        <Empty title={t.contacts} />
      ) : (
        <ul className="support-rows">
          {list.data.items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="support-row"
                onClick={() => setSelected(c.id)}
              >
                <span className="support-row-title">
                  {c.name ?? c.email ?? "—"}
                </span>
                <span className="support-row-meta">{c.email ?? ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <ContactDetail
          key={selected}
          id={selected}
          canEdit={canEdit}
          onChanged={() => {
            list.refresh();
          }}
          onMerged={(into) => {
            setSelected(into);
            list.refresh();
          }}
        />
      )}
    </div>
  );
}

function ContactDetail({
  id,
  canEdit,
  onChanged,
  onMerged,
}: {
  id: string;
  canEdit: boolean;
  onChanged: () => void;
  onMerged: (into: string) => void;
}) {
  const { project, locale } = useWorkspace();
  const t = supportText(locale);
  const detail = useResource<Contact>(
    supportPath(project.id, `/contacts/${id}`),
  );
  const [name, setName] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [into, setInto] = useState("");
  const save = useMutation(() => {
    detail.refresh();
    onChanged();
  });
  const merge = useMutation();
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data)
    return <ResourceError error={detail.error} retry={detail.refresh} />;
  const c = detail.data;
  return (
    <section className="panel support-contact-detail" aria-label={t.contact}>
      <h2>{c.name ?? c.email ?? "—"}</h2>
      <p>{c.email}</p>
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.run(() =>
              patch(supportPath(project.id, `/contacts/${id}`), {
                name: name ?? c.name,
                notes: notes ?? c.notes,
              }),
            );
          }}
        >
          <label>
            <span>{t.name}</span>
            <Input
              value={name ?? c.name ?? ""}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span>{t.notes}</span>
            <Textarea
              value={notes ?? c.notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={save.pending}>
            {t.save}
          </Button>
          {save.error && <Alert kind="error">{save.error}</Alert>}
        </form>
      )}
      <h3>{t.tickets}</h3>
      <ul>
        {(c.tickets ?? []).map((ticket) => (
          <li key={ticket.id}>
            #{ticket.number} {ticket.subject} ·{" "}
            {t.status[ticket.status as keyof typeof t.status]}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await merge.run(() =>
              post(supportPath(project.id, `/contacts/${id}/merge`), {
                intoContactId: into.trim(),
              }),
            );
            if (done) onMerged(into.trim());
          }}
        >
          <label>
            <span>{t.mergeAction}</span>
            <Input
              value={into}
              placeholder="Contact id"
              onChange={(e) => setInto(e.target.value)}
            />
          </label>
          <Button type="submit" size="sm" variant="outline">
            {t.mergeAction}
          </Button>
          {merge.error && <Alert kind="error">{merge.error}</Alert>}
        </form>
      )}
    </section>
  );
}
