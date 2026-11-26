import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** A row of a menu drawn in the compact sheet. */
export interface MenuRow {
  id: string;
  label: string;
  icon?: ReactNode;
  disabledReason?: string | null;
  /** Opens a page rather than running something. */
  drillIn?: boolean;
  run(): void;
}

export function MenuList({
  label,
  rows
}: {
  label: string;
  rows: readonly MenuRow[];
}) {
  return (
    <ul className="compact-menu" aria-label={label}>
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="compact-menu-row"
            data-sheet-row={row.id}
            disabled={Boolean(row.disabledReason)}
            title={row.disabledReason ?? undefined}
            onClick={row.run}
          >
            <span className="compact-menu-icon" aria-hidden="true">
              {row.icon}
            </span>
            <span className="compact-menu-label">{row.label}</span>
            {row.drillIn ? (
              <ChevronRight
                className="compact-menu-chevron"
                size={18}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
