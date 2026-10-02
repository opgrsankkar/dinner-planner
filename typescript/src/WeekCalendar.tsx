import { useEffect, useMemo, useRef } from "react";
import { calendarWeeks, monthKey } from "./week-calendar";

type Props = {
  open: boolean;
  selectedWeek: string;
  currentDate: string;
  onSelect: (week: string) => void;
  onClose: () => void;
};

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const labelDate = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function WeekCalendar({ open, selectedWeek, currentDate, onSelect, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const weeks = useMemo(() => calendarWeeks(currentDate), [currentDate]);
  const hasSelectedWeek = weeks.some((week) => week.start === selectedWeek);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      const focusWeek = hasSelectedWeek ? selectedWeek : weeks.find((week) => week.dates.includes(currentDate))?.start;
      element.querySelector<HTMLButtonElement>(`[data-week-start="${focusWeek}"]`)?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open, currentDate, hasSelectedWeek, selectedWeek, weeks]);

  return (
    <dialog
      ref={dialog}
      className="confirm-dialog week-picker-dialog"
      aria-labelledby="week-picker-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <div className="week-picker-heading">
        <div>
          <h2 id="week-picker-title">Choose a week</h2>
          <p>Select any week within two months of this month.</p>
        </div>
        <button type="button" className="week-picker-close" aria-label="Close week picker" onClick={onClose}>×</button>
      </div>
      <div className="week-calendar" role="group" aria-label="Monday-first calendar">
        <div className="week-calendar-header">
          <span aria-hidden="true" />
          {weekdays.map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="week-calendar-rows">
          {weeks.map((week) => {
            const selected = week.start === selectedWeek && hasSelectedWeek;
            return (
              <div className={`week-calendar-row${selected ? " is-selected" : ""}`} key={week.start}>
                <span className={`week-calendar-month${week.labelMonth === monthKey(currentDate) ? " is-current-month" : ""}`} aria-hidden="true">
                  {week.monthLabel}
                </span>
                <button
                  type="button"
                  className="week-calendar-week"
                  data-week-start={week.start}
                  aria-label={`Week of ${labelDate(week.start)}${selected ? ", selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(week.start)}
                >
                  {week.dates.map((date) => {
                    const dateMonth = monthKey(date);
                    const classes = [
                      "week-calendar-date",
                      dateMonth === monthKey(currentDate) ? "is-current-month" : "is-adjacent-month",
                      date === currentDate ? "is-today" : "",
                    ].filter(Boolean).join(" ");
                    return <span className={classes} key={date} aria-hidden="true">{date.slice(-2).replace(/^0/, "")}</span>;
                  })}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
