// Decides whether a planned meal's date+slot time is already past when the meal
// is submitted, using the configured Asia/Kolkata timezone. The comparison uses
// HH:mm granularity exactly like the planner's default-slot cutoff, so a slot at
// the current minute is still considered current rather than past. The decision
// is made once, at submission; it is never recomputed when the worker runs.
export function isPastSlot(
  date: string,
  time: string,
  now: Date = new Date(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = new Date(`${date}T12:00:00Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date
  )
    return false;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return false;
  const currentDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    currentDate.find((item) => item.type === type)?.value ?? "";
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const currentTime = `${part("hour")}:${part("minute")}`;
  if (date < today) return true;
  if (date > today) return false;
  // Date-only slots (invalid or empty time) are never treated as past.
  return time < currentTime;
}
