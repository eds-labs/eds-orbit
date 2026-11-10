"use client";
import { useContext, useReducer, useState } from "react";
import { ShellContext } from "@/platform/shell/shell-context";
import { ApiError } from "@/lib/api";
import { Alert, Badge, Button, Field, FieldLabel, Input, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import {
  socialPath,
  socialSend,
  SocialApiError,
  type PostView,
  type SocialAccount,
  type SocialMedia,
  type ValidationIssue,
} from "../api";
import { postMessage, socialText } from "../labels";
import { editorReducer, emptyEditor, toPostInput } from "./editor-state";
import { scheduleErrorView, ScheduleField, type ScheduleChoice } from "./schedule-field";
import { VariantTabs } from "./variant-tabs";
import { OriginNote } from "../origin";

// The post editor (ADR 0020, S4). Owners schedule and publish directly (their
// action is the approval); editors ask the owner. Changes are saved before
// anything is scheduled, so the request names exactly what was shown.

const APPROVAL_BEARING = ["needs_approval", "approved", "scheduled"];
const statusTone = { draft: "neutral", needs_approval: "warning", approved: "success", scheduled: "blue" } as const;

const issuesOf = (post: PostView | null) =>
  Object.fromEntries((post?.variants ?? []).map((v) => [v.accountId, v.issues])) as Record<string, ValidationIssue[]>;

export function PostEditor({
  post: initial,
  accounts,
  library,
  onSaved,
}: {
  post: PostView | null;
  accounts: SocialAccount[];
  library: SocialMedia[];
  onSaved: (post: PostView) => void;
}) {
  const { project, locale, isOwner } = useWorkspace();
  const all = socialText(locale);
  const t = all.posts;
  const [post, setPost] = useState<PostView | null>(initial);
  // Drive images copied into the library while the post is open; the
  // page's library list is not reloaded, as a reload remounts the editor.
  const [imported, setImported] = useState<SocialMedia[]>([]);
  const allMedia = [...library, ...imported.filter((m) => !library.some((l) => l.id === m.id))];
  const googleDrive = useContext(ShellContext)?.features?.googleDrive === true;
  const [state, dispatch] = useReducer(editorReducer, initial, (p) =>
    p ? editorReducer(emptyEditor(), { type: "load", post: p }) : emptyEditor(),
  );
  const [issues, setIssues] = useState<Record<string, ValidationIssue[]>>(() => issuesOf(initial));
  const [when, setWhen] = useState(() => {
    const [date = "", time = ""] = (initial?.schedule.local ?? "").split("T");
    return { date, time };
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [scheduleError, setScheduleError] = useState<{ message: string; choices?: ScheduleChoice[] } | null>(null);
  const [confirmMove, setConfirmMove] = useState(false);
  const locked = busy || post?.readOnly === true;
  const timeZone = post?.schedule.timeZone ?? project.timezone ?? "UTC";
  const local = when.date && when.time ? `${when.date}T${when.time}` : "";

  const loaded = (next: PostView) => {
    setPost(next);
    dispatch({ type: "load", post: next });
    setIssues(issuesOf(next));
    onSaved(next);
    return next;
  };
  const fail = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "REQUEST_FAILED";
    const detail = error instanceof SocialApiError ? error.detail : null;
    if (code.startsWith("SOCIAL_SCHEDULE_")) setScheduleError(scheduleErrorView(code, detail, local, locale));
    if (code === "SOCIAL_VALIDATION_FAILED" && Array.isArray(detail?.variants))
      setIssues(
        Object.fromEntries(
          (detail.variants as Array<{ accountId: string; issues: ValidationIssue[] }>).map((v) => [v.accountId, v.issues]),
        ),
      );
    setMessage({ kind: "error", text: code === "SOCIAL_NO_ACCOUNT" ? t.chooseAccount : postMessage(code, locale) });
  };
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setMessage(null);
    setScheduleError(null);
    try {
      await work();
      if (done) setMessage({ kind: "success", text: done });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  /** The stored post with the editor's changes. */
  const save = async (): Promise<PostView> => {
    if (!state.accounts.length) throw new ApiError("SOCIAL_NO_ACCOUNT", 422);
    if (post && !state.dirty) return post;
    const body = toPostInput(state);
    return loaded(
      post
        ? await socialSend<PostView>(socialPath(project.id, `/posts/${post.id}`), "PATCH", { ...body, version: post.version })
        : await socialSend<PostView>(socialPath(project.id, "/posts"), "POST", body),
    );
  };
  const submitTime = (extra: { fold?: "earlier" | "later"; local?: string; reapprove?: boolean } = {}) =>
    run(async () => {
      const saved = await save();
      const target = extra.local ?? local;
      const body = { version: saved.version, local: target, timeZone, ...(extra.fold ? { fold: extra.fold } : {}) };
      const moving = APPROVAL_BEARING.includes(saved.status);
      if (moving && isOwner && !extra.reapprove) {
        setConfirmMove(true);
        return;
      }
      const path = `/posts/${saved.id}/${moving ? "reschedule" : "schedule"}`;
      const next = loaded(
        await socialSend<PostView>(socialPath(project.id, path), "POST", moving ? { ...body, reapprove: extra.reapprove } : body),
      );
      setMessage({ kind: "success", text: next.status === "needs_approval" ? t.requested : t.approved });
    });
  const choose = (choice: ScheduleChoice) => {
    if (choice.local) {
      const [date = "", time = ""] = choice.local.split("T");
      setWhen({ date, time });
    }
    void submitTime({ fold: choice.fold, local: choice.local });
  };
  const action = (path: string, done: string) =>
    run(async () => {
      const saved = await save();
      loaded(await socialSend<PostView>(socialPath(project.id, `/posts/${saved.id}/${path}`), "POST", { version: saved.version }));
    }, done);

  const status = post?.status ?? "draft";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(save, t.saved);
      }}
    >
      {post && (
        <p>
          <Badge tone={statusTone[status as keyof typeof statusTone] ?? "neutral"}>{t.status[status]}</Badge>{" "}
          <OriginNote post={{ ...post, approvalState: post.approval.state }} locale={locale} />
        </p>
      )}
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      <Field>
        <FieldLabel htmlFor="social-post-title">{t.titleLabel}</FieldLabel>
        <Input
          id="social-post-title"
          maxLength={200}
          value={state.title}
          disabled={locked}
          onChange={(e) => dispatch({ type: "title", title: e.target.value })}
        />
      </Field>
      <fieldset>
        <legend>{t.accounts}</legend>
        <ul className="settings-rows">
          {accounts
            .filter((a) => a.status !== "disabled" || state.accounts.includes(a.id))
            .map((a) => {
              const id = `social-post-account-${a.id}`;
              const chosen = state.accounts.includes(a.id);
              return (
                <li key={a.id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={chosen}
                    disabled={locked || (!chosen && a.status !== "active")}
                    onChange={() => dispatch({ type: "toggleAccount", accountId: a.id })}
                  />{" "}
                  <label htmlFor={id}>
                    {a.handle} <span className="field-hint">{all.platform[a.platform]}</span>
                  </label>{" "}
                  {a.status !== "active" && <Badge tone="warning">{all.status[a.status]}</Badge>}
                </li>
              );
            })}
        </ul>
      </fieldset>
      <VariantTabs
        projectId={project.id}
        state={state}
        dispatch={dispatch}
        accounts={accounts}
        library={allMedia}
        driveEnabled={googleDrive}
        onImported={(media) => setImported((list) => [...list, media])}
        known={[...(post?.baseMedia ?? []), ...(post?.variants.flatMap((v) => v.media) ?? [])]}
        issues={issues}
        disabled={locked}
        locale={locale}
      />
      <ScheduleField
        date={when.date}
        time={when.time}
        timeZone={timeZone}
        locale={locale}
        disabled={locked}
        onChange={setWhen}
        error={scheduleError}
        onChoice={choose}
      />
      <div className="form-actions">
        <Button type="submit" variant="outline" disabled={locked}>
          {t.save}
        </Button>{" "}
        <Button
          type="button"
          variant="outline"
          disabled={locked}
          onClick={() =>
            run(async () => {
              const saved = await save();
              const result = await socialSend<{ variants: Array<{ accountId: string; issues: ValidationIssue[] }> }>(
                socialPath(project.id, `/posts/${saved.id}/validate`),
                "POST",
                {},
              );
              setIssues(Object.fromEntries(result.variants.map((v) => [v.accountId, v.issues])));
            }, t.checked)
          }
        >
          {t.check}
        </Button>{" "}
        <Button type="button" disabled={locked || !local} onClick={() => void submitTime()}>
          {isOwner ? t.schedule : t.requestApproval}
        </Button>{" "}
        <Button
          type="button"
          variant="outline"
          disabled={locked || APPROVAL_BEARING.includes(status)}
          onClick={() => action("publish-now", isOwner ? t.approved : t.requested)}
        >
          {isOwner ? t.publishNow : t.requestPublication}
        </Button>{" "}
        {post && APPROVAL_BEARING.includes(status) && (
          <Button type="button" variant="outline" disabled={locked} onClick={() => action("cancel", t.saved)}>
            {t.cancel}
          </Button>
        )}{" "}
        {post && status === "draft" && (
          <Button type="button" variant="ghost" disabled={locked} onClick={() => action("archive", t.saved)}>
            {t.archive}
          </Button>
        )}
      </div>
      {confirmMove && (
        <Modal title={t.moveTitle} description={t.moveBody} onClose={() => setConfirmMove(false)}>
          <Button variant="outline" onClick={() => setConfirmMove(false)}>
            {t.keep}
          </Button>{" "}
          <Button
            onClick={() => {
              setConfirmMove(false);
              void submitTime({ reapprove: true });
            }}
          >
            {t.move}
          </Button>
        </Modal>
      )}
    </form>
  );
}
