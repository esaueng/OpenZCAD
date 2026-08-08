import { useState } from 'react';
import {
  Check,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  Pencil,
  Ruler,
  Trash2,
  X
} from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import type {
  FormattedMeasurement,
  Measurement,
  MeasurementDisplayOptions,
  MeasurementMode,
  RadialDisplay
} from '../lib/measurements';

const MODE_LABELS: Record<MeasurementMode, string> = {
  smart: 'Smart',
  distance: 'Distance',
  angle: 'Angle'
};

const MODE_INSTRUCTIONS: Record<MeasurementMode, string> = {
  smart: 'Pick an edge, face, hole, or body to inspect it.',
  distance: 'Pick two targets. Circles and cylinders use their exact centers.',
  angle: 'Pick two straight edges or two planar faces.'
};

interface MeasurementDockProps {
  measurements: Measurement[];
  formattedMeasurements: Record<string, FormattedMeasurement>;
  enabled: boolean;
  activeMeasurementId: string | null;
  mode: MeasurementMode;
  draftTargetLabel: string | null;
  display: MeasurementDisplayOptions;
  onMode(mode: MeasurementMode): void;
  onUnit(unit: UnitSystem): void;
  onPrecision(precision: number): void;
  onRadialDisplay(display: RadialDisplay): void;
  onSelect(id: string): void;
  onToggleVisibility(id: string): void;
  onRename(id: string, label: string, note: string): void;
  onDelete(id: string): void;
  onClear(): void;
  onCopy(measurement?: Measurement): void;
  onExport(): void;
}

/** View-only measurement workbench; every mutation is runtime session state. */
export function MeasurementDock({
  measurements,
  formattedMeasurements,
  enabled,
  activeMeasurementId,
  mode,
  draftTargetLabel,
  display,
  onMode,
  onUnit,
  onPrecision,
  onRadialDisplay,
  onSelect,
  onToggleVisibility,
  onRename,
  onDelete,
  onClear,
  onCopy,
  onExport
}: MeasurementDockProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftNote, setDraftNote] = useState('');

  function beginEdit(measurement: Measurement) {
    setEditingId(measurement.id);
    setDraftLabel(measurement.label);
    setDraftNote(measurement.note ?? '');
  }

  function finishEdit(id: string) {
    const label = draftLabel.trim();
    if (label) {
      onRename(id, label, draftNote.trim());
    }
    setEditingId(null);
  }

  const instruction = !enabled
    ? 'Measure is off. Choose a mode or press M to resume.'
    : draftTargetLabel
      ? `${draftTargetLabel} selected. Pick the second target.`
      : MODE_INSTRUCTIONS[mode];

  return (
    <aside className="measurement-dock" aria-label="Measurement workbench">
      <header className="measurement-dock-head">
        <Ruler size={14} aria-hidden="true" />
        <h2>Measure</h2>
        {measurements.length > 0 ? (
          <button
            type="button"
            className="measurement-dock-clear"
            title="Clear every measurement"
            onClick={onClear}
          >
            Clear all
          </button>
        ) : null}
      </header>

      <div className="measurement-mode-tabs" role="group" aria-label="Measurement type">
        {(Object.keys(MODE_LABELS) as MeasurementMode[]).map((candidate) => (
          <button
            type="button"
            key={candidate}
            className={candidate === mode ? 'active' : undefined}
            aria-pressed={candidate === mode}
            onClick={() => onMode(candidate)}
          >
            {MODE_LABELS[candidate]}
          </button>
        ))}
      </div>

      <p className="measurement-dock-instruction" aria-live="polite">
        {instruction}
      </p>

      <div className="measurement-display-controls">
        <label>
          <span>Units</span>
          <select
            aria-label="Measurement units"
            value={display.unit}
            onChange={(event) => onUnit(event.target.value as UnitSystem)}
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
            <option value="inch">in</option>
          </select>
        </label>
        <label>
          <span>Precision</span>
          <select
            aria-label="Measurement decimal places"
            value={display.precision}
            onChange={(event) => onPrecision(Number(event.target.value))}
          >
            {[0, 1, 2, 3, 4].map((precision) => (
              <option key={precision} value={precision}>
                {precision}
              </option>
            ))}
          </select>
        </label>
        <div className="measurement-radial-toggle" role="group" aria-label="Radial display">
          <button
            type="button"
            className={display.radialDisplay === 'diameter' ? 'active' : undefined}
            aria-pressed={display.radialDisplay === 'diameter'}
            onClick={() => onRadialDisplay('diameter')}
            title="Show diameters"
          >
            Ø
          </button>
          <button
            type="button"
            className={display.radialDisplay === 'radius' ? 'active' : undefined}
            aria-pressed={display.radialDisplay === 'radius'}
            onClick={() => onRadialDisplay('radius')}
            title="Show radii"
          >
            R
          </button>
        </div>
      </div>

      {measurements.length === 0 ? (
        <p className="measurement-dock-empty">
          Results stay in this View session and never change the model.
        </p>
      ) : (
        <div className="measurement-dock-list" role="list">
          {measurements.map((entry) => {
            const formatted = formattedMeasurements[entry.id] ?? {
              value: 'Unavailable',
              quality: 'Unavailable'
            };
            const editing = editingId === entry.id;
            return (
              <div
                className={`measurement-row${
                  activeMeasurementId === entry.id ? ' active' : ''
                }${entry.status !== 'current' ? ' stale' : ''}`}
                role="listitem"
                key={entry.id}
              >
                {editing ? (
                  <form
                    className="measurement-row-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      finishEdit(entry.id);
                    }}
                  >
                    <label>
                      <span>Name</span>
                      <input
                        autoFocus
                        value={draftLabel}
                        onChange={(event) => setDraftLabel(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>Note</span>
                      <input
                        value={draftNote}
                        onChange={(event) => setDraftNote(event.target.value)}
                        placeholder="Optional inspection note"
                      />
                    </label>
                    <span className="measurement-row-editor-actions">
                      <button type="submit" title="Save measurement details">
                        <Check size={13} aria-hidden="true" />
                        Save
                      </button>
                      <button
                        type="button"
                        title="Cancel editing"
                        onClick={() => setEditingId(null)}
                      >
                        <X size={13} aria-hidden="true" />
                        Cancel
                      </button>
                    </span>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="measurement-row-main"
                      onClick={() => onSelect(entry.id)}
                      aria-pressed={activeMeasurementId === entry.id}
                    >
                      <span className="measurement-row-heading">
                        <span className="measurement-row-label" title={entry.label}>
                          {entry.label}
                        </span>
                        <span className={`measurement-quality ${entry.quality}`}>
                          {formatted.quality}
                        </span>
                        {entry.status !== 'current' ? (
                          <span className={`measurement-status ${entry.status}`}>
                            {entry.status}
                          </span>
                        ) : null}
                      </span>
                      <span className="measurement-row-value">{formatted.value}</span>
                      {formatted.detail ? (
                        <small className="measurement-row-note">{formatted.detail}</small>
                      ) : null}
                      {entry.note ? (
                        <small className="measurement-row-user-note">{entry.note}</small>
                      ) : null}
                    </button>
                    <span className="measurement-row-actions">
                      <button
                        type="button"
                        title={entry.visible ? 'Hide viewport annotation' : 'Show viewport annotation'}
                        aria-label={entry.visible ? `Hide ${entry.label}` : `Show ${entry.label}`}
                        onClick={() => onToggleVisibility(entry.id)}
                      >
                        {entry.visible ? (
                          <Eye size={13} aria-hidden="true" />
                        ) : (
                          <EyeOff size={13} aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        title="Copy this measurement"
                        aria-label={`Copy ${entry.label}`}
                        onClick={() => onCopy(entry)}
                      >
                        <ClipboardCopy size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        title="Rename or add a note"
                        aria-label={`Edit ${entry.label}`}
                        onClick={() => beginEdit(entry)}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        title="Delete this measurement"
                        aria-label={`Delete ${entry.label}`}
                        onClick={() => onDelete(entry.id)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {measurements.length > 0 ? (
        <footer className="measurement-dock-foot">
          <button type="button" onClick={() => onCopy()} title="Copy every row">
            <ClipboardCopy size={12} aria-hidden="true" />
            Copy all
          </button>
          <button type="button" onClick={onExport} title="Download structured CSV">
            <Download size={12} aria-hidden="true" />
            CSV
          </button>
        </footer>
      ) : null}
    </aside>
  );
}
