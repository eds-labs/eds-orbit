"use client";

import {
  Component,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Ellipsis, GripVertical, Plus, SlidersHorizontal } from "lucide-react";
import {
  Alert,
  Button,
  Empty,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import { api, ApiError, put, useResource } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import type { HomeWidget } from "./types";
import {
  defaultHomeLayout,
  MAX_WIDGETS,
  moveHomeWidget,
  type HomeLayout,
  type WidgetPlacement,
} from "./home-layout";
import { widgetText } from "./home-widget-text";
import styles from "./home-widgets.module.css";

type WidgetWords = ReturnType<typeof widgetText>;

class WidgetBoundary extends Component<
  { children: ReactNode; text: WidgetWords },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    const { text, children } = this.props;
    if (!this.state.failed) return children;
    return (
      <div className="panel">
        <div className="home-card-body">
          <Alert kind="error">{text.unavailable}</Alert>
          <Button
            variant="outline"
            onClick={() => this.setState({ failed: false })}
          >
            {text.retry}
          </Button>
        </div>
      </div>
    );
  }
}

function WidgetCell({
  widget,
  placement,
  edit,
  busy,
  previous,
  next,
  locale,
  keyboardState,
  instructionsId,
  onKeyDown,
  onKeyboardBlur,
  onMove,
  onResize,
  onRemove,
}: {
  widget: HomeWidget;
  placement: WidgetPlacement;
  edit: boolean;
  busy: boolean;
  previous?: string;
  next?: string;
  locale: Locale;
  keyboardState?: "picked" | "target";
  instructionsId: string;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
  onKeyboardBlur(): void;
  onMove(to: string): void;
  onResize(size: WidgetPlacement["size"]): void;
  onRemove(): void;
}) {
  const text = widgetText(locale);
  const title = widget.title[locale];
  const Card = widget.component;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsId = useId();
  const optionsButton = useRef<HTMLButtonElement>(null);
  function closeOptions() {
    setOptionsOpen(false);
    optionsButton.current?.focus();
  }
  const sortable = useSortable({ id: widget.id, disabled: !edit || busy });
  return (
    <li
      className={styles.cell}
      data-size={placement.size}
      data-widget={widget.id}
      data-dragging={sortable.isDragging || undefined}
      data-keyboard-state={keyboardState}
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      {edit && (
        <div className={styles.tools}>
          <Button
            {...sortable.attributes}
            {...sortable.listeners}
            ref={sortable.setActivatorNodeRef}
            size="icon"
            variant="ghost"
            className={styles.handle}
            disabled={busy}
            aria-label={`${text.move}: ${title}`}
            aria-describedby={instructionsId}
            aria-pressed={sortable.isDragging || keyboardState === "picked"}
            onKeyDown={onKeyDown}
            onBlur={onKeyboardBlur}
          >
            <GripVertical aria-hidden="true" />
          </Button>
          <strong>{title}</strong>
          <label className={styles.size}>
            <span className="sr-only">{`${text.size}: ${title}`}</span>
            <select
              className="input"
              value={placement.size}
              disabled={busy}
              onChange={(event) =>
                onResize(event.target.value === "wide" ? "wide" : "compact")
              }
            >
              <option value="compact">{text.compact}</option>
              <option value="wide">{text.wide}</option>
            </select>
          </label>
          <div
            className={styles.options}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget))
                setOptionsOpen(false);
            }}
            onKeyDown={(event) => {
              if (optionsOpen && event.key === "Escape") {
                event.preventDefault();
                closeOptions();
              }
            }}
          >
            <Button
              ref={optionsButton}
              size="icon"
              variant="ghost"
              disabled={busy}
              aria-expanded={optionsOpen}
              aria-controls={optionsOpen ? optionsId : undefined}
              aria-label={`${text.options}: ${title}`}
              onClick={() => setOptionsOpen(!optionsOpen)}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
            {optionsOpen && (
              <div id={optionsId} className={styles.menu}>
                <Button
                  variant="ghost"
                  disabled={!previous || busy}
                  onClick={() => {
                    closeOptions();
                    if (previous) onMove(previous);
                  }}
                >
                  {text.earlier}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!next || busy}
                  onClick={() => {
                    closeOptions();
                    if (next) onMove(next);
                  }}
                >
                  {text.later}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setOptionsOpen(false);
                    onRemove();
                  }}
                >
                  {text.remove}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={styles.content}>
        <WidgetBoundary text={text}>
          <Card />
        </WidgetBoundary>
      </div>
    </li>
  );
}

export function HomeWidgets({ widgets }: { widgets: readonly HomeWidget[] }) {
  const { project, locale, t } = useWorkspace();
  const text = widgetText(locale);
  const sectionId = useId();
  const instructionsId = useId();
  const path = `/projects/${encodeURIComponent(project.id)}/home-layout`;
  const resource = useResource<HomeLayout>(path);
  const [updated, setUpdated] = useState<HomeLayout>();
  // undefined is view mode. null is a draft that restores the standard layout.
  const [draft, setDraft] = useState<WidgetPlacement[] | null>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<"save" | "conflict">();
  const [notice, setNotice] = useState("");
  const [keyboardMove, setKeyboardMove] = useState<{
    id: string;
    target: string;
  }>();
  const lock = useRef(false);
  const customizeRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const saved = updated ?? resource.data;
  const available = new Map(widgets.map((widget) => [widget.id, widget]));
  const defaults = defaultHomeLayout(widgets);
  const layout = (draft === undefined ? saved?.widgets : draft) ?? defaults;
  const visible = layout.filter(({ id }) => available.has(id));
  const edit = draft !== undefined;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
  );

  function finish() {
    setDraft(undefined);
    setKeyboardMove(undefined);
    setFailure(undefined);
    requestAnimationFrame(() => customizeRef.current?.focus());
  }

  async function submit(reload = false) {
    if (!saved || draft === undefined || lock.current) return;
    lock.current = true;
    setBusy(true);
    setNotice("");
    try {
      const value = reload
        ? await api<HomeLayout>(path)
        : await put<HomeLayout>(path, {
            revision: saved.revision,
            widgets: draft,
          });
      setUpdated(value);
      finish();
      if (!reload) setNotice(text.saved);
    } catch (error) {
      setFailure(
        reload || (error instanceof ApiError && error.status === 409)
          ? "conflict"
          : "save",
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }

  function move(from: string, to: string) {
    setDraft(moveHomeWidget(layout, available, from, to));
  }

  function openEditor(add = false) {
    setNotice("");
    setDraft(saved?.widgets ?? null);
    setCatalogOpen(add);
    if (!add) requestAnimationFrame(() => addRef.current?.focus());
  }

  const sortIds = visible.map(({ id }) => id);
  const titleFor = (id: string) => available.get(id)?.title[locale] ?? "";
  const position = (id: string, target: string) =>
    text.at(titleFor(id), sortIds.indexOf(target) + 1, sortIds.length);

  function cancelKeyboardMove(id: string) {
    if (keyboardMove?.id !== id) return;
    setKeyboardMove(undefined);
    setNotice(text.dragCanceled);
  }

  // Keyboard moves follow reading order even when the target is wide or the
  // cards wrap onto another row. The draft only moves when the user drops.
  function moveWithKeyboard(
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ) {
    if (busy) return;
    const { key } = event;
    if (key === " " || key === "Enter") {
      event.preventDefault();
      if (keyboardMove?.id === id) {
        const { target } = keyboardMove;
        const handle = event.currentTarget;
        setKeyboardMove(undefined);
        move(id, target);
        setNotice(position(id, target));
        requestAnimationFrame(() => {
          handle.focus({ preventScroll: true });
          handle.scrollIntoView({ block: "nearest", inline: "nearest" });
        });
      } else {
        setKeyboardMove({ id, target: id });
        setNotice(text.pickedUp(titleFor(id)));
      }
      return;
    }
    if (keyboardMove?.id !== id) return;
    if (key === "Escape") {
      event.preventDefault();
      cancelKeyboardMove(id);
      return;
    }
    const direction =
      key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : key === "ArrowRight" || key === "ArrowDown"
          ? 1
          : 0;
    if (!direction) return;
    event.preventDefault();
    const target = sortIds[sortIds.indexOf(keyboardMove.target) + direction];
    if (!target) return;
    setKeyboardMove({ id, target });
    setNotice(position(id, target));
  }

  return (
    <section aria-labelledby={sectionId} className={styles.dashboard}>
      <div className={styles.header}>
        <h2 id={sectionId}>{text.dashboard}</h2>
        {saved && !edit && (
          <Button
            ref={customizeRef}
            variant="outline"
            onClick={() => openEditor()}
          >
            <SlidersHorizontal aria-hidden="true" /> {text.customize}
          </Button>
        )}
        {edit && (
          <div className={styles.actions}>
            <Button
              ref={addRef}
              variant="outline"
              disabled={busy}
              onClick={() => setCatalogOpen(true)}
            >
              <Plus aria-hidden="true" /> {text.add}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              {text.restore}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={finish}>
              {text.cancel}
            </Button>
            <Button
              disabled={busy || failure === "conflict"}
              onClick={() => void submit()}
            >
              {busy ? text.saving : text.save}
            </Button>
          </div>
        )}
      </div>
      {edit && (
        <p className="sr-only" id={instructionsId}>
          {text.instructions}
        </p>
      )}
      <div className="sr-only" role="status">
        {notice}
      </div>
      {failure && (
        <div className={styles.feedback}>
          <Alert kind="error">
            {failure === "conflict" ? text.conflict : text.saveError}
          </Alert>
          {failure === "conflict" && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {text.reload}
            </Button>
          )}
        </div>
      )}
      {!saved && resource.loading && <Loading label={t("loading")} />}
      {!saved && resource.error && (
        <div className={styles.feedback}>
          <Alert kind="error">{text.loadError}</Alert>
          <Button variant="outline" onClick={resource.refresh}>
            {text.retry}
          </Button>
        </div>
      )}
      {(saved || resource.error) &&
        (visible.length ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={() => setKeyboardMove(undefined)}
            onDragEnd={({ active, over }) => {
              if (edit && !busy && over && active.id !== over.id)
                move(String(active.id), String(over.id));
            }}
            accessibility={{
              screenReaderInstructions: { draggable: text.instructions },
              announcements: {
                onDragStart: ({ active }) =>
                  text.pickedUp(titleFor(String(active.id))),
                onDragOver: ({ active, over }) =>
                  over
                    ? position(String(active.id), String(over.id))
                    : undefined,
                onDragEnd: ({ active, over }) =>
                  over
                    ? position(String(active.id), String(over.id))
                    : text.dragCanceled,
                onDragCancel: () => text.dragCanceled,
              },
            }}
          >
            <SortableContext items={sortIds} strategy={rectSortingStrategy}>
              <ul className={styles.grid}>
                {visible.map((placement, index) => (
                  <WidgetCell
                    key={placement.id}
                    widget={available.get(placement.id)!}
                    placement={placement}
                    edit={edit}
                    busy={busy}
                    previous={sortIds[index - 1]}
                    next={sortIds[index + 1]}
                    locale={locale}
                    instructionsId={instructionsId}
                    keyboardState={
                      keyboardMove?.id === placement.id
                        ? "picked"
                        : keyboardMove?.target === placement.id
                          ? "target"
                          : undefined
                    }
                    onKeyDown={(event) => moveWithKeyboard(event, placement.id)}
                    onKeyboardBlur={() => cancelKeyboardMove(placement.id)}
                    onMove={(to) => move(placement.id, to)}
                    onResize={(size) =>
                      setDraft(
                        layout.map((p) =>
                          p.id === placement.id ? { ...p, size } : p,
                        ),
                      )
                    }
                    onRemove={() => {
                      setDraft(layout.filter(({ id }) => id !== placement.id));
                      addRef.current?.focus();
                    }}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <div className={`panel ${styles.empty}`}>
            <Empty title={text.empty} />
            {saved && !edit && (
              <Button variant="outline" onClick={() => openEditor(true)}>
                {text.add}
              </Button>
            )}
          </div>
        ))}
      {catalogOpen && (
        <Modal
          title={text.catalog}
          onClose={() => {
            setCatalogOpen(false);
            requestAnimationFrame(() => addRef.current?.focus());
          }}
        >
          {layout.length >= MAX_WIDGETS && <Alert>{text.limit}</Alert>}
          {widgets.length ? (
            <ul className={styles.catalog}>
              {[...widgets]
                .sort((a, b) =>
                  a.title[locale].localeCompare(b.title[locale], locale),
                )
                .map((widget) => {
                  const added = layout.some(({ id }) => id === widget.id);
                  return (
                    <li key={widget.id}>
                      <div>
                        <strong>{widget.title[locale]}</strong>
                        <p>{widget.description[locale]}</p>
                      </div>
                      <Button
                        variant="outline"
                        aria-label={`${added ? text.added : text.add}: ${widget.title[locale]}`}
                        disabled={added || layout.length >= MAX_WIDGETS}
                        onClick={() => {
                          setDraft([
                            ...layout,
                            { id: widget.id, size: widget.defaultSize },
                          ]);
                          setCatalogOpen(false);
                          requestAnimationFrame(() => addRef.current?.focus());
                        }}
                      >
                        {added ? text.added : text.add}
                      </Button>
                    </li>
                  );
                })}
            </ul>
          ) : (
            <Empty title={text.catalogEmpty} />
          )}
        </Modal>
      )}
    </section>
  );
}
