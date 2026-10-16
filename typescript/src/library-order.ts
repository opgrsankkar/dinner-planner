import type { Meal } from "./types";

// The planner side panel floats just-created meals to the top so they can be
// used immediately. Meals already in the library keep their existing order.
// `recentIds` is most-recent-first; unknown ids are ignored.
export function orderLibrary(
  library: Meal[],
  recentIds: readonly string[],
): Meal[] {
  if (!recentIds.length) return library;
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return [...library].sort((a, b) => {
    const left = rank.get(a.id);
    const right = rank.get(b.id);
    if (left === undefined) return right === undefined ? 0 : 1;
    if (right === undefined) return -1;
    return left - right;
  });
}
