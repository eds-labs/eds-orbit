"use client";
import { useState } from "react";
import { ApiError } from "@/lib/api";
import { Alert, Button, Modal } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import {
  socialPath,
  socialSend,
  SocialApiError,
  type CalendarItem,
  type PostView,
} from "../api";
import { socialText } from "../labels";
import {
  ScheduleField,
  scheduleErrorView,
  type ScheduleChoice,
} from "../posts/schedule-field";
import { moveCheck, moveFlow, rescheduleBody } from "./move";

// "Move to…" and drops that need a choice (S6, S-D6): the new time in the
// project's zone, the confirmation when the approval changes, and the
// server's choices when the time falls into a clock change. Nothing moves
// until the person confirms.

export type MoveError =
  | { kind: "choices"; view: { message: string; choices?: ScheduleChoice[] } }
  | { kind: "conflict"; message: string }
  | { kind: "message"; message: string };

export type MoveResult =
  | { kind: "moved"; post: PostView; local: string }
  | { kind: "conflict"; message: string };

/** What a refused move shows: the clock-change choices, the conflict notice or the code's message. */
export function moveError(
  code: string,
  detail: unknown,
  local: string,
  locale: "en" | "de",
): MoveError {
  if (code === "SOCIAL_VERSION_CONFLICT")
    return { kind: "conflict", message: socialText(locale).calendar.conflict };
  const view = scheduleErrorView(code, detail, local, locale);
  return view.choices
    ? { kind: "choices", view }
    : { kind: "message", message: view.message };
}

/** The error of a failed move request. */
export function moveErrorOf(
  error: unknown,
  local: string,
  locale: "en" | "de",
): MoveError {
  const code = error instanceof ApiError ? error.code : "REQUEST_FAILED";
  return moveError(
    code,
    error instanceof SocialApiError ? error.detail : null,
    local,
    locale,
  );
}

/** POST …/posts/:postId/reschedule. */
export function sendMove(
  projectId: string,
  item: CalendarItem,
  local: string,
  timeZone: string,
  opts: { reapprove?: boolean; fold?: "earlier" | "later" },
) {
  return socialSend<PostView>(
    socialPath(projectId, `/posts/${encodeURIComponent(item.id)}/reschedule`),
    "POST",
    rescheduleBody(item, local, timeZone, opts),
  );
}

export function MoveDialog({
  item,
  target,
  initialError = null,
  onClose,
  onDone,
}: {
  item: CalendarItem;
  target: { local: string; fold?: "earlier" | "later" };
  initialError?: MoveError | null;
  onClose: () => void;
  onDone: (result: MoveResult) => void;
}) {
  const { project, locale, isOwner, canEdit } = useWorkspace();
  const t = socialText(locale).calendar;
  const timeZone = project.timezone;
  const [when, setWhen] = useState({
    date: target.local.slice(0, 10),
    time: target.local.slice(11, 16),
  });
  const [error, setError] = useState<MoveError | null>(initialError);
  const [busy, setBusy] = useState(false);
  const flow = moveFlow(
    moveCheck(
      item,
      isOwner ? "owner" : canEdit ? "editor" : "viewer",
      "project",
    ),
  );

  const submit = async (
    extra: { fold?: "earlier" | "later"; local?: string } = {},
  ) => {
    const local = extra.local ?? `${when.date}T${when.time}`;
    const fold =
      extra.fold ?? (local === target.local ? target.fold : undefined);
    setBusy(true);
    setError(null);
    try {
      const post = await sendMove(project.id, item, local, timeZone, {
        reapprove: flow === "confirmReapprove",
        fold,
      });
      onDone({ kind: "moved", post, local: post.schedule.local ?? local });
    } catch (e) {
      const found = moveErrorOf(e, local, locale);
      if (found.kind === "conflict") onDone(found);
      else setError(found);
    } finally {
      setBusy(false);
    }
  };
  const choose = (choice: ScheduleChoice) => {
    if (choice.local)
      setWhen({
        date: choice.local.slice(0, 10),
        time: choice.local.slice(11, 16),
      });
    void submit({ fold: choice.fold, local: choice.local });
  };

  return (
    <Modal
      title={t.moveTitle}
      description={item.title || item.excerpt || undefined}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>{t.moveIntro}</p>
        <ScheduleField
          date={when.date}
          time={when.time}
          timeZone={timeZone}
          locale={locale}
          disabled={busy}
          onChange={setWhen}
          error={error?.kind === "choices" ? error.view : null}
          onChoice={choose}
        />
        {error?.kind === "message" && (
          <Alert kind="error">{error.message}</Alert>
        )}
        {flow && (
          <p className="field-hint">
            {flow === "confirmReapprove"
              ? t.confirmReapprove
              : t.confirmRequest}
          </p>
        )}
        <div className="button-row">
          <Button type="button" variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={busy || !when.date || !when.time}>
            {flow === "confirmReapprove"
              ? t.moveApprove
              : flow === "confirmRequest"
                ? t.moveRequest
                : t.move}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
