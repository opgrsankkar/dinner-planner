export type CalendarWeek = {
  start: string;
  dates: string[];
  monthLabel: string;
  labelMonth: string;
};

const iso = (date: Date) => date.toISOString().slice(0, 10);
const dateFromIso = (value: string) => new Date(`${value}T12:00:00Z`);

export function monthKey(value: string) {
  return value.slice(0, 7);
}

export function calendarWeeks(currentDate: string): CalendarWeek[] {
  const current = dateFromIso(currentDate);
  const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 2, 1, 12));
  const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 3, 0, 12));
  const firstMonth = monthKey(iso(first));
  const lastMonth = monthKey(iso(new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 2, 1, 12))));
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  last.setUTCDate(last.getUTCDate() + (7 - ((last.getUTCDay() + 6) % 7)) % 7);

  const weeks: CalendarWeek[] = [];
  for (const cursor = new Date(first); cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(cursor);
      date.setUTCDate(date.getUTCDate() + index);
      return iso(date);
    });
    const monthStart = dates.find((date) => date.endsWith("-01"));
    const thursday = dateFromIso(dates[3]);
    const labelDate = monthStart ? dateFromIso(monthStart) : thursday;
    const monthOfLabel = monthKey(iso(labelDate));
    const label = monthStart && monthOfLabel >= firstMonth && monthOfLabel <= lastMonth
      ? labelDate.toLocaleDateString("en", { month: "long", timeZone: "UTC" })
      : "";
    const withYear = label && labelDate.getUTCMonth() === 0
      ? `${label} ${labelDate.getUTCFullYear()}`
      : label;
    weeks.push({ start: dates[0], dates, monthLabel: withYear, labelMonth: monthOfLabel });
  }
  return weeks;
}

export function mondayOf(value: string) {
  const date = dateFromIso(value);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return iso(date);
}
