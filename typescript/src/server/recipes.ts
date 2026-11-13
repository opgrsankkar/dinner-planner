import type { Card, Meal, Slot } from "../types";
import type { Recipe } from "../recipe";
import { findMealByName } from "../meal-names";
import { addDays } from "../week-calendar";

// An API failure with an HTTP status (404, 409, 413…) and optional field issues.
export class RequestError extends Error {
  constructor(message: string, readonly status = 400, readonly issues?: string[]) {
    super(message);
  }
}

// The one rule for which library meal (and so which recipe) a planned card
// belongs to. Cards store the meal name they were planned with, not a library
// id, so:
//  1. a card that recorded the library meal it was planned from (local mode,
//     since recipes shipped) keeps that meal, even after the meal is renamed;
//  2. otherwise the card's name is matched to a meal's name, then to its
//     alternate names, ignoring case and repeated spaces (findMealByName).
// Names and alternate names are unique across the library, so the match is
// unambiguous. A card that matches nothing has no library meal and no recipe.
export function resolveCardMeal<T extends Meal>(
  card: { name: string; mealId?: string },
  library: readonly T[],
): T | undefined {
  return (card.mealId ? library.find((meal) => meal.id === card.mealId) : undefined)
    ?? findMealByName(library, card.name);
}

const kolkataOffsetMs = 330 * 60000;
// "2026-11-10T20:00:00+05:30" for an instant.
export function kolkataIso(ms: number) {
  return new Date(ms + kolkataOffsetMs).toISOString().slice(0, 19) + "+05:30";
}
// Today's date in Asia/Kolkata.
export function kolkataDate(ms: number) {
  return new Date(ms + kolkataOffsetMs).toISOString().slice(0, 10);
}
// The instant a meal slot starts, or NaN for a missing/invalid date or time.
export function slotInstant(date: string, time: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NaN;
  const ms = Date.parse(`${date}T${time}:00+05:30`);
  return kolkataIso(ms).startsWith(`${date}T${time}`) ? ms : NaN;
}

// Parses a range bound: an ISO 8601 date-time with Z or an offset, or a local
// "YYYY-MM-DDTHH:MM[:SS]" read as Asia/Kolkata.
export function parseInstant(value: string, name: string) {
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value);
  const ms = local ? Date.parse(value + "+05:30") : zoned ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms))
    throw new RequestError(`Invalid ${name}: use an ISO 8601 date-time such as 2026-11-10T18:00:00+05:30`);
  return ms;
}

export const maxPrepRangeDays = 14;

// Default window: from now until the end of tomorrow in Asia/Kolkata, which
// answers "what should I start tonight or tomorrow".
export function prepRange(now: number, from?: string | null, to?: string | null) {
  const start = from ? parseInstant(from, "from") : now;
  const end = to ? parseInstant(to, "to") : Date.parse(`${addDays(kolkataDate(start), 2)}T00:00:00+05:30`);
  if (end <= start) throw new RequestError("`to` must be after `from`");
  if (end - start > maxPrepRangeDays * 86400000)
    throw new RequestError(`Range may span at most ${maxPrepRangeDays} days`);
  return { from: start, to: end };
}

export type PrepReminder = {
  // When to do the prep: slot time minus hoursBefore, in Asia/Kolkata.
  dueAt: string;
  dueDate: string;
  dueTime: string;
  text: string;
  hoursBefore: number;
  // The planned meal it is for.
  mealName: string;
  libraryMealId: string;
  cardId: string;
  date: string;
  slotId: string | null;
  slotName: string;
  slotTime: string;
  mealAt: string;
  // Due before `from` while the meal itself is still ahead (only with includeOverdue).
  overdue: boolean;
};

// Prep items due in [from, to): every planned card that resolves to a meal
// with a recipe contributes one reminder per prep item. With includeOverdue,
// items that fell due before `from` for meals starting after `from` are
// included too, marked overdue. Cards being deleted, and cards without a valid
// date and time, are skipped.
export function prepReminders(
  cards: readonly Card[],
  slots: readonly Slot[],
  library: readonly Meal[],
  recipes: ReadonlyMap<string, Recipe>,
  from: number,
  to: number,
  includeOverdue = false,
): PrepReminder[] {
  const reminders: (PrepReminder & { at: number; mealMs: number })[] = [];
  for (const card of cards) {
    const meal = resolveCardMeal(card, library);
    const recipe = meal && recipes.get(meal.id);
    if (!meal || !recipe?.prep.length) continue;
    const mealMs = slotInstant(card.date, card.time);
    if (!Number.isFinite(mealMs)) continue;
    const slot = slots.find((entry) => entry.id === card.slotId);
    for (const item of recipe.prep) {
      // Whole minutes, so 0.5 h is exactly 30 minutes before.
      const at = mealMs - Math.round(item.hoursBefore * 60) * 60000;
      const overdue = at < from && includeOverdue && mealMs > from;
      if ((at < from && !overdue) || at >= to) continue;
      const due = kolkataIso(at);
      reminders.push({
        at,
        mealMs,
        dueAt: due,
        dueDate: due.slice(0, 10),
        dueTime: due.slice(11, 16),
        text: item.text,
        hoursBefore: item.hoursBefore,
        mealName: card.name,
        libraryMealId: meal.id,
        cardId: card.id,
        date: card.date,
        slotId: slot?.id ?? null,
        slotName: slot?.name ?? "",
        slotTime: card.time,
        mealAt: kolkataIso(mealMs),
        overdue,
      });
    }
  }
  return reminders
    .sort((a, b) => a.at - b.at || a.mealMs - b.mealMs || a.mealName.localeCompare(b.mealName))
    .map(({ at: _at, mealMs: _mealMs, ...reminder }) => reminder);
}
