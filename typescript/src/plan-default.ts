import type { Card, Slot } from "./types";

export function defaultPlanPlacement(
  week: string,
  slots: Slot[],
  cards: Card[],
  now = new Date(),
): { date: string; slotId: string } | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  const currentTime = `${value("hour")}:${value("minute")}`;
  // The modal only offers dates from its displayed week. Do not claim a global
  // default from another week when that date cannot be selected here.
  if (week > today) return null;
  const chronologicalSlots = [...slots].sort((a, b) => a.time.localeCompare(b.time));

  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(`${week}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const day = date.toISOString().slice(0, 10);
    if (day < today) continue;
    for (const slot of chronologicalSlots) {
      if (day === today && slot.time < currentTime) continue;
      if (
        cards.some(
          (card) =>
            card.date === day &&
            (card.slotId === slot.id || card.time === slot.time),
        )
      )
        continue;
      return { date: day, slotId: slot.id };
    }
  }
  return null;
}
