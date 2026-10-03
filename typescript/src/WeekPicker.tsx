import { useEffect, useRef, useState } from "react";
const iso = (date: Date) => { const pad = (n: number) => n.toString().padStart(2, "0"); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };

export function getWeeks(centerDate: Date) {
  const centerYear = centerDate.getFullYear();
  const centerMonth = centerDate.getMonth();
  
  const startDate = new Date(centerYear, centerMonth - 2, 1);
  const endDate = new Date(centerYear, centerMonth + 3, 0);
  
  const startWeekDay = startDate.getDay();
  const diff = startWeekDay === 0 ? 6 : startWeekDay - 1;
  const firstMonday = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() - diff);
  
  let current = new Date(firstMonday);
  const weeks = [];
  
  let lastMonthPrinted: number | null = null;
  let lastYearPrinted: number | null = null;
  
  while (current <= endDate || current.getDay() !== 1) {
    const weekDays = [];
    let monthName = "";
    let yearName = "";
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(current);
      weekDays.push(d);
      
      if (lastMonthPrinted !== d.getMonth()) {
        if (d.getDate() === 1 || weeks.length === 0) {
          const mName = d.toLocaleString('default', { month: 'short' });
          monthName = mName;
          lastMonthPrinted = d.getMonth();
          
          if (d.getMonth() === 0 && lastYearPrinted !== d.getFullYear()) {
            yearName = d.getFullYear().toString();
            lastYearPrinted = d.getFullYear();
          }
        }
      }
      
      current.setDate(current.getDate() + 1);
    }
    
    const weekStartIso = iso(weekDays[0]);
    
    weeks.push({
      id: weekStartIso,
      days: weekDays,
      monthName,
      yearName
    });
    
    if (current > endDate && current.getDay() === 1) {
      break;
    }
  }
  
  return weeks;
}

export function WeekPickerModal({
  selectedWeekIso,
  onSelect,
  isOpen,
  onClose,
}: {
  selectedWeekIso: string;
  onSelect: (isoDate: string) => void;
  isOpen: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const [weeks, setWeeks] = useState<{ id: string; days: Date[]; monthName: string; yearName: string }[]>([]);
  const currentActualMonth = new Date().getMonth();
  
  useEffect(() => {
    setWeeks(getWeeks(new Date()));
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) {
      dialog.showModal();
      // Scroll to selected week or current date if selected week is outside
      setTimeout(() => {
        if (scrollRef.current) {
          let target = scrollRef.current.querySelector('.selected-week') as HTMLElement;
          if (!target) {
            // Find a week containing today's date? Or just don't scroll.
            // Actually scrolling to the middle (current month) is a good fallback.
          }
          if (target) {
            target.scrollIntoView({ block: 'center', behavior: 'instant' });
          }
        }
      }, 0);
    } else if (!isOpen && dialog && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onClose]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog week-picker-dialog"
      aria-label="Select week"
      onClick={(e) => {
        if (e.target === dialogRef.current) {
          onClose();
        }
      }}
    >
      <div className="week-picker-header">
        <h2>Select week</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="week-picker-scroll" ref={scrollRef}>
        <div className="week-picker-calendar">
          {weeks.map((week) => {
            const isSelected = week.id === selectedWeekIso;
            return (
              <button
                key={week.id}
                className={`week-row ${isSelected ? 'selected-week' : ''}`}
                onClick={() => {
                  onSelect(week.id);
                  onClose();
                }}
                aria-pressed={isSelected}
                style={{
                  display: 'flex',
                  alignItems: 'stretch',
                  width: '100%',
                  background: isSelected ? undefined : 'transparent',
                  border: 'none',
                  padding: '4px 0',
                  textAlign: 'left'
                }}
              >
                <div className="month-label-col">
                  {week.monthName} {week.yearName}
                </div>
                <div className="days-col">
                  {week.days.map((day, i) => {
                    const isCurrentMonth = day.getMonth() === currentActualMonth;
                    return (
                      <div
                        key={i}
                        className={`day-cell ${isCurrentMonth ? 'current-month-day' : 'other-month-day'}`}
                      >
                        {day.getDate()}
                      </div>
                    );
                  })}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </dialog>
  );
}
