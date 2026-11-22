import { useLayoutEffect, useRef, useState } from 'react';
import { useSettledFlag } from '../hooks/useSettledFlag';
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Ruler,
  Trash2,
  X
} from 'lucide-react';
import type { UnitSystem } from '@openzcad/shared';
import type {
  FormattedMeasurement,
  Measurement,
  MeasurementDisplayOptions,
  MeasurePointKind,
  RadialDisplay
} from '../lib/measurements';
import type {
  MeasureReadingKind,
  MeasureSessionView
} from '../lib/measureReadings';

/** M13: the point kinds a Distance reading can record, in the order offered. */
const POINT_KIND_LABELS: Record<MeasurePointKind, string> = {
  auto: 'Auto',
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  center: 'Center',
  centroid: 'Centroid'
};

const UNIT_LABELS: Record<UnitSystem, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in'
};

/** Decimal places the dock offers: everything a stored record may carry. */
const PRECISIONS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The toggle that opened this dock, which closing it hands focus back to. Both
 * rails (View's bar and Build's instrument rail) name their toggle "Measure".
 */
const MEASURE_TOGGLE = 'button[aria-label="Measure"][aria-pressed]';

const NO_SESSION: MeasureSessionView = {
  first: null,
  second: null,
  readings: [],
  primary: null,
  distanceRefusal: null
};

interface MeasurementDockProps {
  measurements: Measurement[];
  formattedMeasurements: Record<string, FormattedMeasurement>;
  enabled: boolean;
  geometryPending?: boolean;
  activeMeasurementId: string | null;
  /** The live picks and every reading they support. */
  session?: MeasureSessionView;
  display: MeasurementDisplayOptions;
  /**
   * M13: which point a Distance reading records. Offered in the settings
   * menu; omitted, the dock offers no choice.
   */
  pointKind?: MeasurePointKind;
  onPointKind?(kind: MeasurePointKind): void;
  /** Shows another of the session's readings large; Keep records it. */
  onChooseReading?(kind: MeasureReadingKind): void;
  /** Records the reading shown large. */
  onKeep?(): void;
  /** Drops both picks without recording anything. */
  onClearPicks?(): void;
  onUnit(unit: UnitSystem): void;
  onPrecision(precision: number): void;
  onRadialDisplay(display: RadialDisplay): void;
  onSelect(id: string): void;
  /**
   * M13: the row under the pointer or keyboard focus, whose measured edges
   * and faces the viewport highlights; null when none is.
   */
  onHover?(id: string | null): void;
  onToggleVisibility(id: string): void;
  onRename(id: string, label: string, note: string): void;
  onDelete(id: string): void;
  onClear(): void;
  onCopy(measurement?: Measurement): void;
  onExport(): void;
}

/** How long an update must run before the dock marks its rows as updating. */
export const MEASUREMENT_UPDATING_MS = 400;

/**
 * The measurement workbench: pick one or two things, read every figure they
 * support, keep the ones worth keeping. Results are saved with the project,
 * never with the model: nothing here changes geometry.
 */
export function MeasurementDock({
  measurements,
  formattedMeasurements,
  enabled,
  geometryPending = false,
  activeMeasurementId,
  session = NO_SESSION,
  display,
  pointKind = 'auto',
  onPointKind,
  onChooseReading,
  onKeep,
  onClearPicks,
  onUnit,
  onPrecision,
  onRadialDisplay,
  onSelect,
  onHover,
  onToggleVisibility,
  onRename,
  onDelete,
  onClear,
  onCopy,
  onExport
}: MeasurementDockProps) {
  // Copies and CSV are held from the first pending frame, so no stale value
  // leaves the dock. Saying "Updating…" waits until the update has taken
  // visible time: most finish within a frame or two, and swapping every value
  // out and back read as the dock flashing.
  const updating = useSettledFlag(geometryPending, MEASUREMENT_UPDATING_MS);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const dockRef = useRef<HTMLElement>(null);
  // The row whose Edit button takes focus back once its editor closes: the
  // editor held focus, and unmounting it would drop focus on the body.
  const refocusEditRef = useRef<string | null>(null);

  // Escape, the rail and M all close the dock by unmounting it. Done while it
  // held focus, that dropped focus on the body; it goes back to the Measure
  // toggle instead. A layout cleanup runs before the dock leaves the DOM, so
  // where focus was can still be read.
  useLayoutEffect(() => {
    const dock = dockRef.current;
    return () => {
      const owner = dock?.ownerDocument;
      if (!dock || !owner || !dock.contains(owner.activeElement)) {
        return;
      }
      owner.querySelector<HTMLElement>(MEASURE_TOGGLE)?.focus();
    };
  }, []);

  function beginEdit(measurement: Measurement) {
    setEditingId(measurement.id);
    setDraftLabel(measurement.label);
    setDraftNote(measurement.note ?? '');
  }

  function closeEditor(id: string) {
    refocusEditRef.current = id;
    setEditingId(null);
  }

  function finishEdit(id: string) {
    const label = draftLabel.trim();
    if (label) {
      onRename(id, label, draftNote.trim());
    }
    closeEditor(id);
  }

  const [settingsOpen, setSettingsOpen] = useState(false);
  const { first, second, readings, primary, distanceRefusal } = session;

  const instruction = updating
    ? 'Measurements will refresh when the model finishes updating.'
    : !enabled
      ? 'Measure is off.'
      : second && !primary
        ? (distanceRefusal ??
          'Those two picks share no distance or angle that can be trusted. Pick again to start over.')
        : !first
          ? 'Pick an edge, face, hole or body to measure it. Pick a second target to compare the two.'
          : null;

  return (
    <aside
      ref={dockRef}
      className="measurement-dock"
      aria-label="Measurement workbench"
      data-busy={geometryPending && !updating ? 'quiet' : undefined}
    >
      <header className="measurement-dock-head">
        <Ruler size={14} aria-hidden="true" />
        <h2>Measure</h2>
        <button
          type="button"
          className="measurement-settings-toggle"
          aria-expanded={settingsOpen}
          aria-controls="measurement-settings"
          aria-label="Measurement settings"
          title="Units, precision and points"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          {UNIT_LABELS[display.unit]}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
      </header>

      {/* Everything between the head and the foot scrolls as one: on a short
          screen the reading, Keep and the kept rows stay reachable rather than
          the list collapsing to nothing under a card that cannot move. */}
      <div className="measurement-dock-body">
        {settingsOpen ? (
          <div
            id="measurement-settings"
            className="measurement-display-controls"
          >
            <label>
              <span>Units</span>
              <select
                aria-label="Measurement units"
                value={display.unit}
                onChange={(event) => onUnit(event.target.value as UnitSystem)}
              >
                {(Object.keys(UNIT_LABELS) as UnitSystem[]).map((unit) => (
                  <option key={unit} value={unit}>
                    {UNIT_LABELS[unit]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Precision</span>
              <select
                aria-label="Measurement precision"
                value={display.precision}
                onChange={(event) => onPrecision(Number(event.target.value))}
              >
                {PRECISIONS.map((precision) => (
                  <option key={precision} value={precision}>
                    {precision}
                  </option>
                ))}
              </select>
            </label>
            {onPointKind ? (
              <label>
                <span>Distance points</span>
                <select
                  aria-label="Distance points"
                  value={pointKind}
                  onChange={(event) =>
                    onPointKind(event.target.value as MeasurePointKind)
                  }
                >
                  {(Object.keys(POINT_KIND_LABELS) as MeasurePointKind[]).map(
                    (kind) => (
                      <option key={kind} value={kind}>
                        {POINT_KIND_LABELS[kind]}
                      </option>
                    )
                  )}
                </select>
              </label>
            ) : null}
            <div
              className="measurement-radial-toggle"
              role="group"
              aria-label="Radial display"
            >
              <button
                type="button"
                className={
                  display.radialDisplay === 'diameter' ? 'active' : undefined
                }
                aria-pressed={display.radialDisplay === 'diameter'}
                onClick={() => onRadialDisplay('diameter')}
                aria-label="Diameter"
                title="Show diameters"
              >
                Ø
              </button>
              <button
                type="button"
                className={
                  display.radialDisplay === 'radius' ? 'active' : undefined
                }
                aria-pressed={display.radialDisplay === 'radius'}
                onClick={() => onRadialDisplay('radius')}
                aria-label="Radius"
                title="Show radii"
              >
                R
              </button>
            </div>
          </div>
        ) : null}

        <div className="measurement-picks" role="group" aria-label="Picks">
          <PickSlot letter="A" label={first?.label ?? null} empty="Pick" />
          <PickSlot
            letter="B"
            label={second?.label ?? null}
            empty={first ? 'Compare…' : 'Optional'}
          />
          {first ? (
            <button
              type="button"
              className="measurement-picks-clear"
              aria-label="Clear picks"
              title="Clear picks (Esc)"
              onClick={onClearPicks}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <section className="measurement-live" aria-label="Reading">
          {instruction ? (
            <p className="measurement-dock-instruction" aria-live="polite">
              {instruction}
            </p>
          ) : primary ? (
            <>
              <div className="measurement-live-title">{primary.title}</div>
              <output className="measurement-live-value" aria-live="polite">
                {primary.formatted.value}
              </output>
              {primary.formatted.detail ? (
                <small className="measurement-live-detail">
                  {primary.formatted.detail}
                </small>
              ) : null}
              {readings.length > 1 ? (
                <div
                  className="measurement-readings"
                  role="group"
                  aria-label="Other readings"
                >
                  {readings.map((reading) => (
                    <button
                      type="button"
                      key={reading.kind}
                      aria-pressed={reading.kind === primary.kind}
                      className={
                        reading.kind === primary.kind ? 'active' : undefined
                      }
                      onClick={() => onChooseReading?.(reading.kind)}
                    >
                      <span className="measurement-reading-title">
                        {reading.title}
                      </span>
                      <span className="measurement-reading-value">
                        {reading.formatted.value}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="measurement-live-actions">
                <button
                  type="button"
                  title="Copy this reading"
                  disabled={geometryPending}
                  onClick={() => onCopy(primary.measurement)}
                >
                  <ClipboardCopy size={12} aria-hidden="true" />
                  Copy
                </button>
                <button
                  type="button"
                  className="measurement-keep"
                  title="Keep this reading with the project (Enter)"
                  disabled={geometryPending}
                  onClick={onKeep}
                >
                  <Plus size={13} aria-hidden="true" />
                  Keep
                </button>
              </div>
            </>
          ) : (
            <p className="measurement-dock-instruction" aria-live="polite">
              {first
                ? `${first.label} has no figure of its own. Pick a second target.`
                : null}
            </p>
          )}
        </section>

        {measurements.length > 0 ? (
          <header className="measurement-kept-head">
            <span>Kept · {measurements.length}</span>
            <button
              type="button"
              className="measurement-dock-clear"
              title="Clear every measurement"
              onClick={onClear}
            >
              Clear all
            </button>
          </header>
        ) : null}

        {measurements.length === 0 ? (
          <p className="measurement-dock-empty">
            Kept readings are saved with this project and never change the
            model.
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
                  }${updating || entry.status !== 'current' ? ' stale' : ''}`}
                  role="listitem"
                  key={entry.id}
                  // M13: the whole row, actions included, holds the highlight:
                  // moving onto its Copy button or tabbing to an action keeps
                  // the measured entity lit.
                  onPointerEnter={() => onHover?.(entry.id)}
                  onPointerLeave={() => onHover?.(null)}
                  onFocus={() => onHover?.(entry.id)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget))
                      onHover?.(null);
                  }}
                >
                  {editing ? (
                    <form
                      className="measurement-row-editor"
                      onSubmit={(event) => {
                        event.preventDefault();
                        finishEdit(entry.id);
                      }}
                      onKeyDown={(event) => {
                        // Escape here cancels the edit and nothing more. Left
                        // to the workspace, it ended the whole Measure session
                        // and threw the typed name away with the dock.
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          closeEditor(entry.id);
                        }
                      }}
                    >
                      <label>
                        <span>Name</span>
                        <input
                          autoFocus
                          value={draftLabel}
                          onChange={(event) =>
                            setDraftLabel(event.target.value)
                          }
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
                          onClick={() => closeEditor(entry.id)}
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
                          <span
                            className="measurement-row-label"
                            title={entry.label}
                          >
                            {entry.label}
                          </span>
                          <span
                            className={`measurement-quality ${entry.quality}`}
                          >
                            {formatted.quality}
                          </span>
                          {updating || entry.status !== 'current' ? (
                            <span
                              className={`measurement-status ${updating ? 'stale' : entry.status}`}
                            >
                              {updating ? 'updating' : entry.status}
                            </span>
                          ) : null}
                        </span>
                        <span className="measurement-row-value">
                          {updating ? 'Updating…' : formatted.value}
                        </span>
                        {!updating && formatted.detail ? (
                          <small className="measurement-row-note">
                            {formatted.detail}
                          </small>
                        ) : null}
                        {entry.note ? (
                          <small className="measurement-row-user-note">
                            {entry.note}
                          </small>
                        ) : null}
                      </button>
                      <span className="measurement-row-actions">
                        <button
                          type="button"
                          title={
                            entry.visible
                              ? 'Hide viewport annotation'
                              : 'Show viewport annotation'
                          }
                          aria-label={
                            entry.visible
                              ? `Hide ${entry.label}`
                              : `Show ${entry.label}`
                          }
                          onClick={() => onToggleVisibility(entry.id)}
                        >
                          {entry.visible ? (
                            <Eye size={12} aria-hidden="true" />
                          ) : (
                            <EyeOff size={12} aria-hidden="true" />
                          )}
                        </button>
                        <button
                          type="button"
                          title="Copy this measurement"
                          aria-label={`Copy ${entry.label}`}
                          disabled={geometryPending}
                          onClick={() => onCopy(entry)}
                        >
                          <ClipboardCopy size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          title="Rename or add a note"
                          aria-label={`Edit ${entry.label}`}
                          ref={(button) => {
                            if (button && refocusEditRef.current === entry.id) {
                              refocusEditRef.current = null;
                              button.focus();
                            }
                          }}
                          onClick={() => beginEdit(entry)}
                        >
                          <Pencil size={12} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          title="Delete this measurement"
                          aria-label={`Delete ${entry.label}`}
                          onClick={() => onDelete(entry.id)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {measurements.length > 0 ? (
        <footer className="measurement-dock-foot">
          <button
            type="button"
            onClick={() => onCopy()}
            title="Copy every row"
            disabled={geometryPending}
          >
            <ClipboardCopy size={12} aria-hidden="true" />
            Copy all
          </button>
          <button
            type="button"
            onClick={onExport}
            title="Download structured CSV"
            disabled={geometryPending}
          >
            <Download size={12} aria-hidden="true" />
            CSV
          </button>
        </footer>
      ) : null}
    </aside>
  );
}

/** One pick slot, lettered as the viewport labels the pick. */
function PickSlot({
  letter,
  label,
  empty
}: {
  letter: 'A' | 'B';
  label: string | null;
  empty: string;
}) {
  return (
    <span
      className={`measurement-pick${label ? '' : ' empty'}`}
      data-slot={letter}
    >
      <span className="measurement-pick-letter" aria-hidden="true">
        {letter}
      </span>
      <span
        className="measurement-pick-label"
        title={label ?? undefined}
        aria-hidden="true"
      >
        {label ?? empty}
      </span>
      <span className="visually-hidden">
        {label ? `Pick ${letter}: ${label}` : `Pick ${letter} empty`}
      </span>
    </span>
  );
}
