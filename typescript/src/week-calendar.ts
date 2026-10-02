const iso = (date: Date) => date.toISOString().slice(0, 10);
export function addDays(date: string, offset: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return iso(value);
}
export function weekStart(date: string) {
  return addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
}
export function calendarWeeks(today: string) {
  const now = new Date(`${today}T12:00:00Z`);
  const first = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1, 12)));
  const last = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0, 12)));
  const rows: { start: string; dates: string[]; months: string[] }[] = [];
  const seen = new Set<string>();
  for (let start = weekStart(first); start <= last; start = addDays(start, 7)) {
    const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const months: string[] = [];
    for (const date of dates) {
      if (date < first || date > last) continue;
      const month = date.slice(0, 7);
      if (!seen.has(month)) { seen.add(month); months.push(month); }
    }
    rows.push({ start, dates: dates.map(date => date >= first && date <= last ? date : ""), months });
  }
  return { first, last, currentMonth: today.slice(0, 7), rows };
}
export function dateLabel(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
