import type { Entry } from "@diary/contracts";
import { useState, type ReactNode } from "react";
import {
  formatDateLabel,
  formatRailMonth,
  groupEntriesByBeijingDay,
} from "./date-groups";

type DateRailProps = {
  entries: Entry[];
  activeDay?: string;
  footer?: ReactNode;
  onJumpDay?: (day: string) => void;
};

export function DateRail({ entries, activeDay, footer, onJumpDay }: DateRailProps) {
  const groups = groupEntriesByBeijingDay(entries);
  const activeIndex = Math.max(0, groups.findIndex((group) => group.day === activeDay));
  const visibleGroups = groups.slice(Math.max(0, activeIndex - 30), activeIndex + 31);
  const [jumpDay, setJumpDay] = useState(activeDay ?? groups[0]?.day ?? "");
  const jumpLabel = jumpDay ? `Go to ${formatDateLabel(jumpDay)}` : "Go to date";

  return (
    <aside className="date-rail">
      <form className="date-jump" onSubmit={(event) => { event.preventDefault(); if (jumpDay) onJumpDay?.(jumpDay); }}>
        <label className="visually-hidden" htmlFor="date-jump-input">Jump to date</label>
        <input id="date-jump-input" aria-label="Jump to date" type="date" value={jumpDay} onChange={(event) => setJumpDay(event.target.value)} />
        <button type="submit" aria-label={jumpLabel}>{"→"}</button>
      </form>
      <nav className="date-list" aria-label="Diary dates">
        {visibleGroups.map(({ day }) => (
          <a
            className="date-link"
            href={`#day-${day}`}
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
