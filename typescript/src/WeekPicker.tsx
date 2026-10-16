import { useRef } from "react";
import { addDays, calendarWeeks, dateLabel, weekStart } from "./week-calendar";

export function WeekPicker({ week, today, label, isCurrent, onSelect }: {
  week: string; today: string; label: string; isCurrent: boolean; onSelect: (week: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const calendar = calendarWeeks(today);
  const currentStart = weekStart(today);
  const selected = week <= calendar.last && addDays(week, 6) >= calendar.first;
  function open() {
    dialog.current?.showModal();
    const start = selected ? week : weekStart(today);
    const row = dialog.current?.querySelector<HTMLButtonElement>(`[data-week="${start}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center", behavior: "instant" });
  }
  return <>
    <button ref={trigger} type="button" className="week-title week-picker-trigger" aria-label={`${label}${isCurrent ? ", current week" : ""}, choose week`} aria-haspopup="dialog" onClick={open}>
      <span>{label}</span>
      {isCurrent && <span className="week-current-marker" aria-hidden="true">(current)</span>}
    </button>
    <dialog ref={dialog} className="confirm-dialog week-picker" aria-labelledby="week-picker-title"
      onClose={() => trigger.current?.focus({ preventScroll: true })}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}>
      <div className="week-picker-heading">
        <h2 id="week-picker-title">Choose a week</h2>
        <button type="button" className="secondary-button" onClick={() => dialog.current?.close()} aria-label="Close week picker">×</button>
      </div>
      <p className="week-picker-help">Select any row to plan that Monday–Sunday week.</p>
      <div className="week-picker-days" aria-hidden="true"><span />{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span key={day}>{day}</span>)}</div>
      <div className="week-picker-scroll" aria-label="Calendar weeks">
        {calendar.rows.map(row => {
          const isCurrentRow = row.start === currentStart;
          return <div className={`week-picker-row${isCurrentRow ? " is-current-week" : ""}`} key={row.start}>
            <div className="week-picker-months">{row.months.map(month => <div key={month} data-month={month} className={month === calendar.currentMonth ? "current-month" : ""}>
              {new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en", { month: "short", timeZone: "UTC" })}
              {month.endsWith("-01") && <small>{month.slice(0, 4)}</small>}
            </div>)}</div>
            {isCurrentRow && <span className="week-picker-current-star" aria-hidden="true">★</span>}
            <button type="button" className="week-picker-week" data-week={row.start} aria-pressed={selected && week === row.start}
              data-current-week={isCurrentRow ? "true" : undefined}
              aria-current={isCurrentRow ? "date" : undefined}
              aria-label={`Week ${dateLabel(row.start)} to ${dateLabel(addDays(row.start, 6))}${isCurrentRow ? ", current week" : ""}`}
              onClick={() => { onSelect(row.start); dialog.current?.close(); }}>
              {row.dates.map((date, i) => <span key={i} data-date={date || undefined} className={date.slice(0, 7) === calendar.currentMonth ? "current-month" : ""}>
                {date ? Number(date.slice(8)) : ""}
              </span>)}
            </button>
          </div>;
        })}
      </div>
    </dialog>
  </>;
}
