// The calendar after a move (P3): a refresh empties the loaded data for a
// moment; the grid keeps showing the last data of the same path, so scroll
// position and focus stay. Another path (period, filter) shows nothing old.

export type Kept<T> = { path: string | null; data: T | null };

export function keep<T>(previous: Kept<T>, path: string | null, data: T | null): Kept<T> {
  if (data) return { path, data };
  return previous.path === path ? previous : { path, data: null };
}

/** The list restarts from its first page after a move (revision). */
export const listPagesKey = (search: string, revision: number) => `${search}#${revision}`;
