"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/api";
import { Button, Loading, Tabs } from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { PageHead, ResourceError } from "@/platform/ui/collection";
import {
  socialPath,
  type CalendarItem,
  type CalendarResponse,
  type SocialAccounts,
} from "../api";
import { socialText } from "../labels";
import { CalendarDnd, DragHandle, Droppable, type DropTarget } from "./dnd";
import { CalendarFilters } from "./filters";
import { PostDrawer } from "./drawer";
import {
  addDays,
  daySlots,
  localOf,
  monthCells,
  placeByDay,
  placeBySlot,
  rangeOf,
  weekDays,
} from "./grid";
import { CalendarList, PostListPages } from "./list";
import { MonthGrid } from "./month";
import { dropLocal, moveCheck, moveFlow } from "./move";
import {
  MoveDialog,
  moveErrorOf,
  sendMove,
  type MoveError,
  type MoveResult,
} from "./move-dialog";
import {
  apiQuery,
  searchFromState,
  stateFromSearch,
  type CalendarState,
} from "./query";
import { WeekGrid } from "./week";

// Social → Calendar (ADR 0020 §6.2, S6): the posts by month, week or as a
// list in the project's time zone, filtered, optionally across the member's
// projects of the organization. The state lives in the URL.

const shiftMonth = (anchor: string, delta: number) => {
  const [y, m] = anchor.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + delta, 1)).toISOString().slice(0, 10);
};

function periodLabel(state: CalendarState, locale: "en" | "de") {
  const tag = locale === "de" ? "de-DE" : "en-GB";
  const utc = (date: string) => new Date(`${date}T00:00:00Z`);
  if (state.view === "week") {
    const days = weekDays(state.anchor);
    const f = new Intl.DateTimeFormat(tag, {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return `${f.format(utc(days[0]!))} – ${f.format(utc(days[6]!))}`;
  }
  return new Intl.DateTimeFormat(tag, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc(`${state.anchor.slice(0, 7)}-01`));
}

export function CalendarView() {
  const { project, identity, locale, isOwner, canEdit } = useWorkspace();
  const all = socialText(locale);
  const t = all.calendar;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const timeZone = project.timezone;
  const today = localOf(new Date(), timeZone).slice(0, 10);
  const asked = stateFromSearch(
    new URLSearchParams(params?.toString() ?? ""),
    today,
  );
  const projects = identity.projects.filter(
    (p) => p.workspaceId === project.workspaceId,
  );
  const state: CalendarState =
    projects.length > 1
      ? asked
      : { ...asked, scope: "project", projectIds: [] };
  const organization = state.scope === "organization";
  const go = (next: CalendarState) =>
    router.push(`${pathname}?${searchFromState(next)}`, { scroll: false });

  const range = rangeOf(
    state.view === "week" ? "week" : "month",
    state.anchor,
    timeZone,
  );
  const query = apiQuery(state, range);
  const calendarPath =
    state.view === "list" && !organization
      ? null
      : organization
        ? `/organizations/${encodeURIComponent(project.workspaceId)}/social/calendar?${query}`
        : socialPath(project.id, `/calendar?${query}`);
  const calendar = useResource<CalendarResponse>(calendarPath);
  const accounts = useResource<SocialAccounts>(
    socialPath(project.id, "/accounts"),
  );
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const [moving, setMoving] = useState<{
    item: CalendarItem;
    target: { local: string; fold?: "earlier" | "later" };
    error?: MoveError;
  } | null>(null);
  const [notice, setNotice] = useState("");
  const role = isOwner ? "owner" : canEdit ? "editor" : "viewer";
  const checkOf = (item: CalendarItem) =>
    moveCheck(
      item,
      role,
      organization && item.projectId !== project.id
        ? "organization"
        : "project",
    );
  const handleOf = (item: CalendarItem) =>
    checkOf(item).kind === "forbidden" ? null : (
      <DragHandle item={item} locale={locale} />
    );
  const localNow = (item: CalendarItem) =>
    item.schedule.local && item.schedule.timeZone === timeZone
      ? item.schedule.local
      : item.schedule.at
        ? localOf(item.schedule.at, timeZone)
        : "";

  const done = (result: MoveResult) => {
    setMoving(null);
    setNotice(
      result.kind === "conflict"
        ? result.message
        : result.post.status === "needs_approval"
          ? t.movedRequest(result.local.replace("T", " "))
          : t.moved(result.local.replace("T", " ")),
    );
    calendar.refresh();
  };
  /** A drop: a free move is sent at once; one that changes the approval asks first. */
  const drop = async (item: CalendarItem, target: DropTarget) => {
    const check = checkOf(item);
    if (check.kind === "forbidden") return;
    const local = dropLocal(item, target, timeZone);
    if (local === localNow(item) && !target.fold) return;
    const next = { local, fold: target.fold };
    if (moveFlow(check)) return setMoving({ item, target: next });
    setNotice("");
    try {
      const post = await sendMove(project.id, item, local, timeZone, {
        fold: target.fold,
      });
      done({ kind: "moved", post, local: post.schedule.local ?? local });
    } catch (e) {
      const error = moveErrorOf(e, local, locale);
      if (error.kind === "conflict") done(error);
      else if (error.kind === "choices")
        setMoving({ item, target: next, error });
      else setNotice(error.message);
    }
  };

  const items = calendar.data?.items ?? [];
  const repeated = new Set(
    state.view === "week"
      ? weekDays(state.anchor).flatMap((d) =>
          daySlots(d, timeZone)
            .filter((x) => x.repeated)
            .map((x) => x.local),
        )
      : [],
  );
  const step = (delta: number) =>
    go({
      ...state,
      anchor:
        state.view === "week"
          ? addDays(state.anchor, 7 * delta)
          : shiftMonth(state.anchor, delta),
    });
  const label = periodLabel(state, locale);

  return (
    <div className="support-page social-calendar">
      <PageHead title={t.title} description={t.intro} />
      <div className="cal-toolbar">
        <Tabs
          tabs={(["month", "week", "list"] as const).map((key) => ({
            key,
            label: t.views[key],
          }))}
          value={state.view}
          onChange={(view) =>
            go({ ...state, view: view as CalendarState["view"] })
          }
        />
        {(state.view !== "list" || organization) && (
          <div className="cal-period" role="group" aria-label={label}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.previous}
              onClick={() => step(-1)}
            >
              ‹
            </Button>
            <Button
              variant="outline"
              onClick={() => go({ ...state, anchor: today })}
            >
              {t.today}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.next}
              onClick={() => step(1)}
            >
              ›
            </Button>
            <strong className="cal-period-label">{label}</strong>
          </div>
        )}
        {projects.length > 1 && (
          <div className="cal-scope" role="group" aria-label={t.scopeLabel}>
            {(["project", "organization"] as const).map((scope) => (
              <Button
                key={scope}
                variant={state.scope === scope ? "default" : "outline"}
                aria-pressed={state.scope === scope}
                onClick={() =>
                  go({ ...state, scope, projectIds: [], accountIds: [] })
                }
              >
                {scope === "project" ? t.scopeProject : t.scopeOrganization}
              </Button>
            ))}
          </div>
        )}
      </div>
      <CalendarFilters
        state={state}
        accounts={accounts.data?.items ?? []}
        projects={calendar.data?.projects ?? []}
        locale={locale}
        onChange={go}
      />
      <p className="field-hint">{t.zone(timeZone)}</p>
      <p className="field-hint" role="status" aria-live="polite">
        {notice}
      </p>
      <ResourceError error={calendar.error} retry={calendar.refresh} />
      {calendar.loading && !calendar.data && calendarPath && (
        <Loading label={t.title} />
      )}
      {calendar.data?.truncated && (
        <p className="field-hint" role="status">
          {t.truncated}
        </p>
      )}
      {calendar.data && !items.length && state.view !== "list" && (
        <p className="field-hint">{t.empty}</p>
      )}
      <CalendarDnd
        locale={locale}
        onDrop={(item, target) => void drop(item, target)}
      >
        {state.view === "month" && calendar.data && (
          <MonthGrid
            label={label}
            cells={monthCells(state.anchor.slice(0, 7), timeZone, new Date())}
            byDay={placeByDay(items, timeZone)}
            timeZone={timeZone}
            locale={locale}
            showProject={organization}
            onOpen={setOpen}
            onMore={(date) => go({ ...state, view: "week", anchor: date })}
            handleOf={handleOf}
            renderDay={(date, children) =>
              canEdit ? (
                <Droppable id={`day:${date}`} target={{ date, label: date }}>
                  {children}
                </Droppable>
              ) : (
                children
              )
            }
          />
        )}
        {state.view === "week" && calendar.data && (
          <WeekGrid
            label={label}
            days={weekDays(state.anchor)}
            bySlot={placeBySlot(items, timeZone)}
            timeZone={timeZone}
            locale={locale}
            showProject={organization}
            onOpen={setOpen}
            handleOf={handleOf}
            renderSlot={(slot, children) => {
              if (!canEdit) return children;
              const fold = slot.repeated
                ? "later"
                : repeated.has(slot.local)
                  ? "earlier"
                  : undefined;
              return (
                <Droppable
                  id={`slot:${slot.at}`}
                  target={{
                    date: slot.local.slice(0, 10),
                    time: slot.label,
                    fold,
                    label: `${slot.local.replace("T", " ")}${slot.repeated ? ` ${t.repeated("").trim()}` : ""}`,
                  }}
                >
                  {children}
                </Droppable>
              );
            }}
          />
        )}
      </CalendarDnd>
      {state.view === "list" &&
        (organization ? (
          calendar.data && (
            <CalendarList
              items={items}
              timeZone={timeZone}
              locale={locale}
              onOpen={setOpen}
            />
          )
        ) : (
          <PostListPages
            key={searchFromState(state)}
            projectId={project.id}
            state={state}
            timeZone={timeZone}
            locale={locale}
            onOpen={setOpen}
          />
        ))}
      {open && (
        <PostDrawer
          item={open}
          scope={state.scope}
          onClose={() => setOpen(null)}
          onMove={(item) => {
            setOpen(null);
            setMoving({ item, target: { local: localNow(item) } });
          }}
        />
      )}
      {moving && (
        <MoveDialog
          item={moving.item}
          target={moving.target}
          initialError={moving.error ?? null}
          onClose={() => setMoving(null)}
          onDone={done}
        />
      )}
    </div>
  );
}
