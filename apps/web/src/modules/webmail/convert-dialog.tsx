"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useResource } from "@/lib/api";
import { Alert, Button, Input, Modal } from "@/components/ui/primitives";
import {
  convertClient,
  recordsPath,
  type ConvertRecordHit,
  type ConvertReference,
  type ConvertTarget,
} from "./api";
import {
  createConvertSubmitter,
  initialForm,
  loadConvertStage,
  modeOf,
  recordHref,
  selectedDestination,
  selectedTarget,
  withDestination,
  withTarget,
  type ConvertDone,
  type ConvertErrorKey,
  type ConvertForm,
  type ConvertStage,
} from "./convert";
import type { WebmailText } from "./labels";
import styles from "./webmail.module.css";

// The takeover dialog (ADR 0026, E7): native Orbit UI on the member's own
// session. Roundcube only asks for it to open.

const SEARCH_DELAY_MS = 300;

function RecordLink({
  t,
  projectId,
  target,
  recordId,
}: {
  t: WebmailText;
  projectId: string;
  target: string;
  recordId: string;
}) {
  const href = recordHref(projectId, target, recordId);
  if (!href) return null;
  return (
    <Button asChild size="sm">
      <Link href={href}>{t.convert.openTicket}</Link>
    </Button>
  );
}

/** The search results of "add to an existing ticket". */
export function RecordPickerView({
  t,
  query,
  records,
  searching,
  recordId,
  onQuery,
  onPick,
}: {
  t: WebmailText;
  query: string;
  records: readonly ConvertRecordHit[] | null;
  searching: boolean;
  recordId: string;
  onQuery: (query: string) => void;
  onPick: (recordId: string) => void;
}) {
  const c = t.convert;
  return (
    <>
      <label>
        <span>{c.search}</span>
        <Input
          type="search"
          value={query}
          maxLength={200}
          onChange={(e) => onQuery(e.target.value)}
        />
      </label>
      {searching && <p className="field-hint">{c.searching}</p>}
      {!searching && records?.length === 0 && (
        <p className="field-hint">{c.searchNone}</p>
      )}
      {!!records?.length && (
        <ul className={styles.records}>
          {records.map((record) => (
            <li key={record.id}>
              <label className={`settings-check ${styles.option}`}>
                <input
                  type="radio"
                  name="webmail-record"
                  checked={recordId === record.id}
                  onChange={() => onPick(record.id)}
                />
                <span>
                  {record.number !== null && <strong>#{record.number} </strong>}
                  {record.title} <small>{record.status}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RecordSearch({
  t,
  projectId,
  mailboxId,
  form,
  onChange,
}: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  form: ConvertForm;
  onChange: (form: ConvertForm) => void;
}) {
  const [term, setTerm] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setTerm(form.query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [form.query]);
  const hits = useResource<{ records: ConvertRecordHit[] }>(
    term ? recordsPath(projectId, mailboxId, form.targetKey, term) : null,
  );
  return (
    <RecordPickerView
      t={t}
      query={form.query}
      records={term ? (hits.data?.records ?? null) : null}
      searching={!!term && hits.loading}
      recordId={form.recordId}
      onQuery={(query) => onChange({ ...form, query, recordId: "" })}
      onPick={(recordId) => onChange({ ...form, recordId })}
    />
  );
}

/** The choice between a new ticket and an existing one; `search` is the picker. */
export function ConvertFormView({
  t,
  targets,
  form,
  pending,
  waiting,
  error,
  search,
  onChange,
  onSubmit,
  onCancel,
}: {
  t: WebmailText;
  targets: readonly ConvertTarget[];
  form: ConvertForm;
  pending: boolean;
  waiting: boolean;
  error: string | null;
  search: ReactNode;
  onChange: (form: ConvertForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const c = t.convert;
  const target = selectedTarget(targets, form);
  const destination = selectedDestination(target, form);
  const canCreate = !!target?.destinations.length;
  const complete = modeOf(form) !== null;
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete && !pending) onSubmit();
      }}
    >
      <fieldset disabled={pending}>
        {targets.length > 1 && (
          <label>
            <span>{c.target}</span>
            <select
              className="input"
              value={form.targetKey}
              onChange={(e) =>
                onChange(
                  withTarget(
                    form,
                    targets.find((x) => x.key === e.target.value) ?? null,
                  ),
                )
              }
            >
              {targets.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>{c.choice}</legend>
          {canCreate && (
            <label className={`settings-check ${styles.option}`}>
              <input
                type="radio"
                name="webmail-choice"
                checked={form.choice === "new"}
                onChange={() => onChange({ ...form, choice: "new" })}
              />
              <span>{c.createNew}</span>
            </label>
          )}
          <label className={`settings-check ${styles.option}`}>
            <input
              type="radio"
              name="webmail-choice"
              checked={form.choice === "existing"}
              onChange={() => onChange({ ...form, choice: "existing" })}
            />
            <span>{c.addExisting}</span>
          </label>
        </fieldset>
        {form.choice === "new" && destination && (
          <>
            <label>
              <span>{c.inbox}</span>
              <select
                className="input"
                value={form.destinationId}
                onChange={(e) =>
                  onChange(withDestination(form, target, e.target.value))
                }
              >
                {target?.destinations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-hint">
              {destination.address
                ? `${c.repliesFrom}: ${destination.address}`
                : c.repliesNone}
            </p>
            <label>
              <span>{c.subject}</span>
              <Input
                value={form.subject}
                maxLength={500}
                aria-describedby="webmail-subject-hint"
                onChange={(e) => onChange({ ...form, subject: e.target.value })}
              />
              <small className="field-hint" id="webmail-subject-hint">
                {c.subjectHint}
              </small>
            </label>
            <label>
              <span>{c.priority}</span>
              <select
                className="input"
                value={form.priority}
                onChange={(e) => onChange({ ...form, priority: e.target.value })}
              >
                <option value="">{c.priorityDefault}</option>
                {destination.priorities.map((p) => (
                  <option key={p} value={p}>
                    {c.priorities[p] ?? p}
                  </option>
                ))}
              </select>
            </label>
            {destination.categories.length > 0 && (
              <label>
                <span>{c.category}</span>
                <select
                  className="input"
                  value={form.category}
                  onChange={(e) =>
                    onChange({ ...form, category: e.target.value })
                  }
                >
                  <option value="">{c.categoryNone}</option>
                  {destination.categories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              <span>{c.customerAddress}</span>
              <select
                className="input"
                value={form.customerAddress}
                onChange={(e) =>
                  onChange({
                    ...form,
                    customerAddress:
                      e.target.value === "reply_to" ? "reply_to" : "from",
                  })
                }
              >
                <option value="from">{c.addressFrom}</option>
                <option value="reply_to">{c.addressReplyTo}</option>
              </select>
            </label>
          </>
        )}
        {form.choice === "existing" && search}
      </fieldset>
      {waiting && <Alert kind="info">{c.waiting}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      <div className="settings-row-actions">
        <Button type="button" variant="outline" onClick={onCancel}>
          {c.cancel}
        </Button>
        <Button type="submit" disabled={!complete || pending}>
          {pending
            ? c.working
            : form.choice === "new"
              ? c.submit
              : c.submitAdd}
        </Button>
      </div>
    </form>
  );
}

/** What the dialog says once the message is, or already was, in a ticket. */
export function ConvertResultView({
  t,
  projectId,
  result,
  onClose,
}: {
  t: WebmailText;
  projectId: string;
  result: ConvertDone;
  onClose: () => void;
}) {
  const c = t.convert;
  return (
    <div className={styles.result}>
      <Alert kind="success">
        <p>
          {result.duplicate ? c.duplicate(result.number) : c.created(result.number)}
        </p>
        {result.skippedAttachments !== null && (
          <p>{c.skipped(result.skippedAttachments)}</p>
        )}
      </Alert>
      <div className="settings-row-actions">
        <Button type="button" variant="outline" onClick={onClose}>
          {c.close}
        </Button>
        <RecordLink
          t={t}
          projectId={projectId}
          target={result.target}
          recordId={result.recordId}
        />
      </div>
    </div>
  );
}

/** The stages before the form; null while there is nothing to show. */
export function ConvertStageView({
  t,
  projectId,
  stage,
  onRetry,
  onClose,
}: {
  t: WebmailText;
  projectId: string;
  stage: ConvertStage;
  onRetry: () => void;
  onClose: () => void;
}) {
  const c = t.convert;
  if (stage.kind === "already")
    return (
      <div className={styles.result}>
        <Alert kind="info">
          <p>{c.already}</p>
          <p>{c.ticket(stage.number)}</p>
        </Alert>
        <div className="settings-row-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            {c.close}
          </Button>
          <RecordLink
            t={t}
            projectId={projectId}
            target={stage.target}
            recordId={stage.recordId}
          />
        </div>
      </div>
    );
  if (stage.kind === "load_error")
    return (
      <div className={styles.result}>
        <Alert kind="error">{c.errors[stage.error]}</Alert>
        <div className="settings-row-actions">
          <Button type="button" variant="outline" onClick={onClose}>
            {c.close}
          </Button>
          <Button type="button" onClick={onRetry}>
            {t.retry}
          </Button>
        </div>
      </div>
    );
  if (stage.kind === "done")
    return (
      <ConvertResultView
        t={t}
        projectId={projectId}
        result={stage.result}
        onClose={onClose}
      />
    );
  return null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Opens with the check whether the message was already taken over. Renders
 * nothing until it knows the option exists, and closes itself when it does not.
 */
export function ConvertDialog({
  t,
  projectId,
  mailboxId,
  reference,
  onClose,
}: {
  t: WebmailText;
  projectId: string;
  mailboxId: string;
  reference: ConvertReference;
  onClose: () => void;
}) {
  const client = useMemo(
    () => convertClient(projectId, mailboxId),
    [projectId, mailboxId],
  );
  const [stage, setStage] = useState<ConvertStage>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<ConvertForm>(() => initialForm([]));
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<ConvertErrorKey | "stillRunning" | null>(
    null,
  );
  const submitter = useRef(createConvertSubmitter());
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setStage({ kind: "loading" });
    loadConvertStage(client, reference).then((next) => {
      if (!active) return;
      if (next.kind === "form") setForm(initialForm(next.targets));
      setStage(next);
    });
    return () => {
      active = false;
    };
  }, [client, reference, revision]);

  useEffect(() => {
    if (stage.kind === "hidden") onClose();
  }, [stage.kind, onClose]);

  if (stage.kind === "loading" || stage.kind === "hidden") return null;

  async function submit() {
    const mode = modeOf(form);
    if (!mode) return;
    setPending(true);
    setWaiting(false);
    setError(null);
    const outcome = await submitter.current({
      client,
      reference,
      target: form.targetKey,
      mode,
      sleep,
      isCancelled: () => closed.current,
      onWaiting: () => setWaiting(true),
    });
    // Null: a second submit that was refused, or a dialog that closed meanwhile.
    if (outcome === null || closed.current) return;
    setPending(false);
    setWaiting(false);
    if (outcome.kind === "done") setStage(outcome);
    else if (outcome.kind === "still_running") setError("stillRunning");
    else setError(outcome.error);
  }

  const errorText =
    error === null
      ? null
      : error === "stillRunning"
        ? t.convert.stillRunning
        : t.convert.errors[error];

  return (
    <Modal title={t.convert.title} onClose={onClose}>
      {stage.kind === "form" ? (
        <ConvertFormView
          t={t}
          targets={stage.targets}
          form={form}
          pending={pending}
          waiting={waiting}
          error={errorText}
          search={
            <RecordSearch
              t={t}
              projectId={projectId}
              mailboxId={mailboxId}
              form={form}
              onChange={setForm}
            />
          }
          onChange={setForm}
          onSubmit={submit}
          onCancel={onClose}
        />
      ) : (
        <ConvertStageView
          t={t}
          projectId={projectId}
          stage={stage}
          onRetry={() => setRevision((n) => n + 1)}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
