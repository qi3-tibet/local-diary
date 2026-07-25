import type { Entry } from "@diary/contracts";
import type { ReactNode } from "react";
import {
  formatDateLabel,
  formatRailMonth,
  groupEntriesByBeijingDay,
} from "./date-groups";

type DateRailProps = {
  entries: Entry[];
  activeDay?: string;
  footer?: ReactNode;
};

export function DateRail({ entries, activeDay, footer }: DateRailProps) {
  const groups = groupEntriesByBeijingDay(entries);

  return (
    <aside className="date-rail">
      <nav className="date-list" aria-label="Diary dates">
        {groups.map(({ day }) => (
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
