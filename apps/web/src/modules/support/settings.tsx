"use client";
import { useState } from "react";
import { useMutation, useResource } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Input,
  Modal,
  Textarea,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import type { SettingsSection } from "@/platform/shell/types";
import { patch, post, put, supportPath, PRIORITIES, type Inbox } from "./api";
import { supportText, type SupportText } from "./labels";

type Settings = {
  categories: Array<{ key: string; label: string }>;
  sla: Record<
    string,
    { firstResponseMinutes: number; resolutionMinutes: number }
  >;
  autoAck: boolean;
  autoCloseDays: number;
  reopenOnReply: boolean;
  retention: {
    closedTicketMonths: number;
    rawEmailDays: number;
    aiDraftDays: number;
    widgetSessionDays: number;
  };
};

/** "key: label" lines into categories; blank and malformed lines are dropped. */
export function parseCategories(text: string) {
  return text
    .split("\n")
    .map((line) => line.split(":"))
    .filter((parts) => parts.length >= 2 && parts[0]!.trim())
    .map(([key, ...label]) => ({
      key: key!.trim(),
      label: label.join(":").trim(),
    }));
}

/**
 * The snippet an app embeds for the widget (WP5.4). The config is JSON with
 * "<" escaped, so no value can close the script element.
 */
export function embedSnippet(
  origin: string,
  publicKey: string,
  locale: string,
) {
  const config = JSON.stringify({ key: publicKey, locale }).replace(
    /</g,
    "\\u003c",
  );
  return [
    `<script>window.OrbitSupportConfig = ${config};</script>`,
    `<script src="${origin}/widget/v1.js" async></script>`,
  ].join("\n");
}

/** The inbox form's values as the API body (origins one per line). */
export function inboxBody(form: {
  name: string;
  email: boolean;
  widget: boolean;
  emailAddress: string;
  origins: string;
  aiMode: string;
  language: string;
}) {
  const channels = [
    ...(form.email ? ["email"] : []),
    ...(form.widget ? ["widget"] : []),
  ];
  return {
    name: form.name.trim(),
    channels,
    emailAddress: form.email ? form.emailAddress.trim() || null : null,
    allowedOrigins: form.widget
      ? form.origins
          .split("\n")
          .map((o) => o.trim())
          .filter(Boolean)
      : [],
    aiMode: form.aiMode,
    language: form.language,
  };
}

function Inboxes({ t }: { t: SupportText }) {
  const { project, isOwner } = useWorkspace();
  const list = useResource<{ items: Inbox[] }>(
    supportPath(project.id, "/inboxes"),
  );
  const [editing, setEditing] = useState<Inbox | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const { locale } = useWorkspace();
  const action = useMutation(list.refresh);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>{t.settings.inboxes}</h2>
          <p>{t.settings.inboxesHint}</p>
        </div>
        {isOwner && (
          <Button size="sm" onClick={() => setEditing("new")}>
            {t.settings.newInbox}
          </Button>
        )}
      </div>
      <ul className="support-rows">
        {(list.data?.items ?? []).map((inbox) => (
          <li key={inbox.id} className="support-inbox-row">
            <strong>{inbox.name}</strong>{" "}
            {inbox.channels.map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
            {inbox.archivedAt && (
              <Badge tone="warning">{t.settings.archived}</Badge>
            )}
            {inbox.emailAddress && <span> {inbox.emailAddress}</span>}
            {isOwner && !inbox.archivedAt && (
              <span className="support-inbox-actions">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(inbox)}
                >
                  {t.save}
                </Button>
                {inbox.channels.includes("widget") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const result = await action.run(() =>
                        post<{ widgetSecret: string }>(
                          supportPath(
                            project.id,
                            `/inboxes/${inbox.id}/rotate-widget-secret`,
                          ),
                          {},
                        ),
                      );
                      if (result) setSecret(result.widgetSecret);
                    }}
                  >
                    {t.settings.rotate}
                  </Button>
                )}
                {inbox.channels.includes("widget") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const result = await action.run(() =>
                        post<{ publicKey: string }>(
                          supportPath(
                            project.id,
                            `/inboxes/${inbox.id}/widget-key`,
                          ),
                          {},
                        ),
                      );
                      if (result)
                        setSnippet(
                          embedSnippet(
                            window.location.origin,
                            result.publicKey,
                            locale,
                          ),
                        );
                    }}
                  >
                    {t.settings.widgetKey}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    action.run(() =>
                      post(
                        supportPath(project.id, `/inboxes/${inbox.id}/archive`),
                        {},
                      ),
                    )
                  }
                >
                  {t.settings.archive}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {action.error && <Alert kind="error">{action.error}</Alert>}
      {snippet && (
        <Modal
          title={t.settings.widgetKey}
          onClose={() => setSnippet(null)}
          wide
        >
          <p>{t.settings.snippetHint}</p>
          <Textarea
            readOnly
            rows={4}
            value={snippet}
            onFocus={(e) => e.target.select()}
          />
        </Modal>
      )}
      {secret && (
        <Modal title={t.settings.rotate} onClose={() => setSecret(null)}>
          <Alert kind="warning">{t.settings.secretOnce}</Alert>
          <Input readOnly value={secret} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
      {editing && (
        <InboxForm
          t={t}
          inbox={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(widgetSecret) => {
            setEditing(null);
            list.refresh();
            if (widgetSecret) setSecret(widgetSecret);
          }}
        />
      )}
    </section>
  );
}

function InboxForm({
  t,
  inbox,
  onClose,
  onSaved,
}: {
  t: SupportText;
  inbox: Inbox | null;
  onClose: () => void;
  onSaved: (widgetSecret?: string) => void;
}) {
  const { project } = useWorkspace();
  const [form, setForm] = useState({
    name: inbox?.name ?? "",
    email: inbox ? inbox.channels.includes("email") : true,
    widget: inbox ? inbox.channels.includes("widget") : false,
    emailAddress: inbox?.emailAddress ?? "",
    origins: (inbox?.allowedOrigins ?? []).join("\n"),
    aiMode: inbox?.aiMode ?? "off",
    language: inbox?.language ?? "en",
  });
  const save = useMutation();
  const set = (patchValue: Partial<typeof form>) =>
    setForm({ ...form, ...patchValue });
  return (
    <Modal title={inbox ? inbox.name : t.settings.newInbox} onClose={onClose}>
      <form
        className="support-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const body = inboxBody(form);
          const result = await save.run(() =>
            inbox
              ? patch(supportPath(project.id, `/inboxes/${inbox.id}`), {
                  ...body,
                  version: inbox.version,
                })
              : post<{ widgetSecret?: string }>(
                  supportPath(project.id, "/inboxes"),
                  body,
                ),
          );
          if (result)
            onSaved((result as { widgetSecret?: string }).widgetSecret);
        }}
      >
        <label>
          <span>{t.name}</span>
          <Input
            required
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </label>
        <fieldset>
          <legend>{t.settings.channels}</legend>
          <label>
            <input
              type="checkbox"
              checked={form.email}
              onChange={(e) => set({ email: e.target.checked })}
            />{" "}
            {t.settings.emailChannel}
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.widget}
              onChange={(e) => set({ widget: e.target.checked })}
            />{" "}
            {t.settings.widgetChannel}
          </label>
        </fieldset>
        {form.email && (
          <label>
            <span>{t.settings.address}</span>
            <Input
              type="email"
              value={form.emailAddress}
              onChange={(e) => set({ emailAddress: e.target.value })}
            />
          </label>
        )}
        {form.widget && (
          <label>
            <span>{t.settings.origins}</span>
            <Textarea
              value={form.origins}
              onChange={(e) => set({ origins: e.target.value })}
            />
          </label>
        )}
        <label>
          <span>{t.settings.aiMode}</span>
          <select
            value={form.aiMode}
            onChange={(e) => set({ aiMode: e.target.value })}
          >
            <option value="off">{t.settings.aiOff}</option>
            <option value="draft">{t.settings.aiDraft}</option>
          </select>
        </label>
        <label>
          <span>{t.settings.language}</span>
          <select
            value={form.language}
            onChange={(e) => set({ language: e.target.value })}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <Button type="submit" disabled={save.pending}>
          {t.save}
        </Button>
        {save.error && <Alert kind="error">{save.error}</Alert>}
      </form>
    </Modal>
  );
}

function Rules({ t }: { t: SupportText }) {
  const { project, isOwner } = useWorkspace();
  const current = useResource<{ settings: Settings; version: number }>(
    supportPath(project.id, "/settings"),
  );
  const save = useMutation(current.refresh);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<string | null>(null);
  if (!current.data) return null;
  const s = draft ?? current.data.settings;
  const update = (next: Partial<Settings>) => setDraft({ ...s, ...next });
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{t.settings.rules}</h2>
      </div>
      <form
        className="support-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.run(() =>
            put(supportPath(project.id, "/settings"), {
              settings: {
                ...s,
                categories:
                  categories === null
                    ? s.categories
                    : parseCategories(categories),
              },
              version: current.data!.version,
            }),
          );
        }}
      >
        <label>
          <span>{t.settings.categories}</span>
          <Textarea
            disabled={!isOwner}
            value={
              categories ??
              s.categories.map((c) => `${c.key}: ${c.label}`).join("\n")
            }
            onChange={(e) => setCategories(e.target.value)}
          />
        </label>
        <table className="support-sla-table">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{t.settings.firstResponse}</th>
              <th scope="col">{t.settings.resolution}</th>
            </tr>
          </thead>
          <tbody>
            {PRIORITIES.map((p) => (
              <tr key={p}>
                <th scope="row">{t.priority[p]}</th>
                {(["firstResponseMinutes", "resolutionMinutes"] as const).map(
                  (field) => (
                    <td key={field}>
                      <Input
                        type="number"
                        min={1}
                        disabled={!isOwner}
                        aria-label={`${t.priority[p]} ${field === "firstResponseMinutes" ? t.settings.firstResponse : t.settings.resolution}`}
                        value={s.sla[p]![field]}
                        onChange={(e) =>
                          update({
                            sla: {
                              ...s.sla,
                              [p]: {
                                ...s.sla[p]!,
                                [field]: Number(e.target.value),
                              },
                            },
                          })
                        }
                      />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <label>
          <span>{t.settings.autoCloseDays}</span>
          <Input
            type="number"
            min={1}
            max={90}
            disabled={!isOwner}
            value={s.autoCloseDays}
            onChange={(e) => update({ autoCloseDays: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>{t.settings.retentionMonths}</span>
          <Input
            type="number"
            min={1}
            max={72}
            disabled={!isOwner}
            value={s.retention.closedTicketMonths}
            onChange={(e) =>
              update({
                retention: {
                  ...s.retention,
                  closedTicketMonths: Number(e.target.value),
                },
              })
            }
          />
        </label>
        {isOwner && (
          <Button type="submit" disabled={save.pending}>
            {t.save}
          </Button>
        )}
        {save.success && <Alert kind="success">{t.settings.saved}</Alert>}
        {save.error && <Alert kind="error">{save.error}</Alert>}
      </form>
    </section>
  );
}

function useSupportSection() {
  const { locale } = useWorkspace();
  const t = supportText(locale);
  return {
    content: (
      <>
        <Inboxes t={t} />
        <Rules t={t} />
      </>
    ),
  };
}

/** Support's tab of the project settings. */
export const supportSettings: readonly SettingsSection[] = [
  {
    tab: { key: "support", label: { en: "Support", de: "Support" }, order: 40 },
    order: 10,
    useSection: useSupportSection,
  },
];
