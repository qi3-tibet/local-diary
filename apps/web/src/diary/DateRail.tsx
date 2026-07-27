import type { Entry } from "@diary/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  formatDateLabel,
  formatRailMonth,
  groupEntriesByBeijingDay,
} from "./date-groups";

type DateRailProps = {
  entries: Entry[];
  availableDays?: string[];
  activeDay?: string;
  footer?: ReactNode;
  onJumpDay?: (day: string) => void;
};

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function DateRail({
  entries,
  availableDays = [],
  activeDay,
  footer,
  onJumpDay,
}: DateRailProps) {
  const groups = groupEntriesByBeijingDay(entries);
  const activeIndex = Math.max(0, groups.findIndex((group) => group.day === activeDay));
  const visibleGroups = groups.slice(Math.max(0, activeIndex - 30), activeIndex + 31);
  const fallbackDay = activeDay ?? availableDays[0] ?? groups[0]?.day ?? beijingToday();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(fallbackDay.slice(0, 7));
  const recordedDays = useMemo(() => new Set(availableDays), [availableDays]);
  const cells = useMemo(() => monthCells(calendarMonth), [calendarMonth]);
  const monthLabel = formatMonthLabel(calendarMonth);

  useEffect(() => {
    if (activeDay) setCalendarMonth(activeDay.slice(0, 7));
  }, [activeDay]);

  return (
    <aside className="date-rail">
      <div className="date-jump">
        <button
          className="calendar-trigger"
          type="button"
          aria-expanded={calendarOpen}
          aria-label={`Open record calendar for ${monthLabel}`}
          onClick={() => setCalendarOpen((open) => !open)}
        >
          {calendarMonth.replace("-", " / ")}
        </button>
        {calendarOpen ? (
          <section className="record-calendar" role="dialog" aria-label="Record calendar">
            <header className="calendar-header">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setCalendarMonth((month) => shiftMonth(month, -1))}
              >
                {"←"}
              </button>
              <strong>{monthLabel.toUpperCase()}</strong>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setCalendarMonth((month) => shiftMonth(month, 1))}
              >
                {"→"}
              </button>
            </header>
            <div className="calendar-weekdays" aria-hidden="true">
              {WEEKDAYS.map((weekday, index) => (
                <span key={`${weekday}-${index}`}>{weekday}</span>
              ))}
            </div>
            <div className="calendar-grid">
              {cells.map((day, index) => day
                ? recordedDays.has(day)
                  ? (
                    <button
                      className="calendar-day"
                      type="button"
                      aria-label={formatDateLabel(day)}
                      aria-current={activeDay === day ? "date" : undefined}
                      key={day}
                      onClick={() => {
                        setCalendarOpen(false);
                        onJumpDay?.(day);
                      }}
                    >
                      {Number(day.slice(-2))}
                    </button>
                  )
                  : <span className="calendar-day" key={day}>{Number(day.slice(-2))}</span>
                : <span className="calendar-day" aria-hidden="true" key={`blank-${index}`} />)}
            </div>
          </section>
        ) : null}
      </div>
      <nav className="date-list" aria-label="Diary dates">
        {visibleGroups.map(({ day }) => (
          <a
            className="date-link"
            href={`#day-${day}`}
            onClick={(event) => {
              event.preventDefault();
              onJumpDay?.(day);
            }}
            aria-label={formatDateLabel(day)}
            aria-current={activeDay === day ? "date" : undefined}
            key={day}
          >
            <span className="date-month">{formatRailMonth(day)}</span>
            <span className="date-number">{day.slice(-2)}</span>
          </a>
        ))}
      </nav>
      {footer}
    </aside>
  );
}

function monthCells(month: string): Array<string | null> {
  const [year, monthNumber] = month.split("-").map(Number);
  const firstWeekday = new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay();
  const leadingBlanks = (firstWeekday + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: leadingBlanks }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${year}-${String(monthNumber).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}

function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(month: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "long",
    year: "numeric",
  }).format(new Date(`${month}-01T12:00:00+08:00`));
}

function beijingToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
