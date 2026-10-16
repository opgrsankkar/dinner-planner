export type DragPreview = { date: string; slotId: string; name: string };

export function libraryDragPreview(
  meal: { name: string } | null,
  date: string,
  slotId: string,
): DragPreview | null {
  if (!meal || slotId === "unassigned") return null;
  return { date, slotId, name: meal.name };
}

export function sameLibraryDragPreview(
  a: DragPreview | null,
  b: DragPreview | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.date === b.date && a.slotId === b.slotId && a.name === b.name;
}
