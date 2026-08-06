import { ClipboardCopy, Download, Ruler } from 'lucide-react';
import type { Measurement } from '../lib/measurements';

interface MeasurementDockProps {
  measurements: Measurement[];
  onClear(): void;
  onCopy(): void;
  onExport(): void;
}

/**
 * The measure tool's tape. Every pick that carries a number lands here and
 * stays, so an inspection pass — check three holes and an edge against a
 * drawing — reads as a list instead of one figure at a time in the chip.
 *
 * It only reports; nothing here writes to the document, which is what lets a
 * read-only workspace carry it.
 */
export function MeasurementDock({
  measurements,
  onClear,
  onCopy,
  onExport
}: MeasurementDockProps) {
  return (
    <aside className="measurement-dock" aria-label="Measurements">
      <header className="measurement-dock-head">
        <Ruler size={13} aria-hidden="true" />
        <h2>Measurements</h2>
        {measurements.length > 0 && (
          <button
            type="button"
            className="measurement-dock-clear"
            title="Clear the measurement list"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </header>
      {measurements.length === 0 ? (
        <p className="measurement-dock-empty">
          Click an edge, hole or cylinder to record it. Shift-click edges to
          total them.
        </p>
      ) : (
        <>
          <div className="measurement-dock-list" role="list">
            {measurements.map((entry) => (
              <div className="measurement-row" role="listitem" key={entry.key}>
                <span className="measurement-row-label" title={entry.label}>
                  {entry.label}
                </span>
                <span className="measurement-row-value">
                  {entry.value}
                  {entry.note && (
                    <small className="measurement-row-note">{entry.note}</small>
                  )}
                </span>
              </div>
            ))}
          </div>
          <footer className="measurement-dock-foot">
            <button type="button" onClick={onCopy} title="Copy every row">
              <ClipboardCopy size={12} aria-hidden="true" />
              Copy all
            </button>
            <button
              type="button"
              onClick={onExport}
              title="Download the list as CSV"
            >
              <Download size={12} aria-hidden="true" />
              CSV
            </button>
          </footer>
        </>
      )}
    </aside>
  );
}
