import { arrayMove } from "@dnd-kit/sortable";
import type { paths } from "@orbit/api-client";
import type { HomeWidget } from "./types";

export type HomeLayout =
  paths["/api/projects/{projectId}/home-layout"]["get"]["responses"][200]["content"]["application/json"];
export type WidgetPlacement = NonNullable<HomeLayout["widgets"]>[number];
export const MAX_WIDGETS = 100;

export function defaultHomeLayout(
  widgets: readonly HomeWidget[],
): WidgetPlacement[] {
  return widgets
    .filter((widget) => widget.defaultOrder !== undefined)
    .sort((a, b) => (a.defaultOrder ?? 0) - (b.defaultOrder ?? 0))
    .map(({ id, defaultSize }) => ({ id, size: defaultSize }));
}

/** Move only visible widgets, leaving unavailable entries in their saved slots. */
export function moveHomeWidget(
  widgets: WidgetPlacement[],
  available: ReadonlyMap<string, HomeWidget>,
  from: string,
  to: string,
): WidgetPlacement[] {
  const visible = widgets.filter(({ id }) => available.has(id));
  const oldIndex = visible.findIndex(({ id }) => id === from);
  const newIndex = visible.findIndex(({ id }) => id === to);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return widgets;
  const moved = arrayMove(visible, oldIndex, newIndex);
  let index = 0;
  return widgets.map((place) =>
    available.has(place.id) ? moved[index++]! : place,
  );
}
