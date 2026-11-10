"use client";
import type { ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { CalendarItem } from "../api";
import { socialText } from "../labels";

// Dragging posts in the calendar (S6): pointer, touch and keyboard as in the
// work board. A drop names a day (month) or a half-hour slot (week); what
// the move needs is decided by the calendar (moveCheck).

export type DropTarget = {
  date: string;
  time?: string;
  fold?: "earlier" | "later";
  label: string;
};

const titleOf = (item: CalendarItem | undefined) =>
  item?.title || item?.excerpt || "";

export function CalendarDnd({
  locale,
  children,
  onDrop,
}: {
  locale: "en" | "de";
  children: ReactNode;
  onDrop: (item: CalendarItem, target: DropTarget) => void;
}) {
  const t = socialText(locale).calendar;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor),
  );
  const item = (data: unknown) =>
    (data as { item?: CalendarItem } | undefined)?.item;
  const target = (data: unknown) => data as DropTarget | undefined;
  return (
    <DndContext
      sensors={sensors}
      accessibility={{
        screenReaderInstructions: { draggable: t.dragInstructions },
        announcements: {
          onDragStart: ({ active }) =>
            t.dragStart(titleOf(item(active.data.current))),
          onDragOver: ({ active, over }) =>
            over
              ? t.dragOver(
                  titleOf(item(active.data.current)),
                  target(over.data.current)?.label ?? "",
                )
              : undefined,
          onDragEnd: ({ active, over }) =>
            over
              ? t.dragEnd(
                  titleOf(item(active.data.current)),
                  target(over.data.current)?.label ?? "",
                )
              : t.dragCancel(titleOf(item(active.data.current))),
          onDragCancel: ({ active }) =>
            t.dragCancel(titleOf(item(active.data.current))),
        },
      }}
      onDragEnd={({ active, over }: DragEndEvent) => {
        const dragged = item(active.data.current);
        const dropped = target(over?.data.current);
        if (dragged && dropped) onDrop(dragged, dropped);
      }}
    >
      {children}
    </DndContext>
  );
}

/** The handle that picks a movable post up. */
export function DragHandle({
  item,
  locale,
}: {
  item: CalendarItem;
  locale: "en" | "de";
}) {
  const t = socialText(locale).calendar;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${item.projectId}:${item.id}`,
    data: { item },
    attributes: { roleDescription: t.dragRole },
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className="cal-drag"
      data-dragging={isDragging || undefined}
      {...attributes}
      {...listeners}
      aria-label={t.dragHandle(titleOf(item) || item.id)}
    >
      <span aria-hidden="true">⋮⋮</span>
    </button>
  );
}

/** A day or slot posts can be dropped on. */
export function Droppable({
  id,
  target,
  children,
}: {
  id: string;
  target: DropTarget;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, data: target });
  return (
    <div ref={setNodeRef} className="cal-drop" data-over={isOver || undefined}>
      {children}
    </div>
  );
}
