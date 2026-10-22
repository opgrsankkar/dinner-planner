import type { Card, Slot } from "../types";
import { addDays } from "../week-calendar";

// Read-only iCalendar feed of planned meals for phone/Calendar subscriptions.
// Times are written in UTC from the planner's fixed Asia/Kolkata (+05:30) slots.
const pastDays = 14;
const futureDays = 90;
const durationMinutes = 30;

function escapeText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
// RFC 5545 lines are folded at 75 octets with a leading space on continuations.
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = new TextEncoder().encode(char).length;
    if (size + width > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
function utcStamp(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function slotStart(date: string, time: string) {
  return new Date(`${date}T${time}:00+05:30`);
}

export function mealsCalendar(cards: Card[], slots: Slot[], now: Date): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  const from = addDays(today, -pastDays);
  const until = addDays(today, futureDays);
  const slotName = new Map(slots.map((slot) => [slot.id, slot.name]));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//x1c//Meal Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Meals",
    "X-WR-TIMEZONE:Asia/Kolkata",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  const stamp = utcStamp(now);
  const meals = cards
    .filter((card) => card.state === "saved" && !card.deleting && card.time && card.date >= from && card.date <= until)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  for (const card of meals) {
    const start = slotStart(card.date, card.time);
    if (!Number.isFinite(start.getTime())) continue;
    const end = new Date(start.getTime() + durationMinutes * 60000);
    const slot = card.slotId ? slotName.get(card.slotId) : undefined;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${card.id}@meals.x1c`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utcStamp(start)}`,
      `DTEND:${utcStamp(end)}`,
      `SUMMARY:${escapeText(slot ? `${slot} · ${card.name}` : card.name)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
