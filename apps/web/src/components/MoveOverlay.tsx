import { Check, LocateFixed, Spline, SlidersHorizontal, X } from 'lucide-react';
import {
  displayLengthName,
  MAX_TRANSFORM_COPY_STAMPS,
  type UnitSystem
} from '@openzcad/shared';
import { moveHasFiniteValues } from '../lib/moveCard';
import { TOOL_META } from '../lib/tools';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject
} from 'react';
import {
  raiseCompactSheet,
  SHEET_OVERLAY_ATTRIBUTE,
  useCompactKeypadSlot,
  useCompactCommandTray
} from './compact/compactSlots';

/*
 * The Move bar (U09): the gizmo is the command, so this is the in-place
 * Cancel / Done pill every command finishes on, with the exact numbers, the
 * name, the body and Copy behind its Options. Its own module, loaded only
 * once a Move starts, so its fields stay off the entry chunk (App.tsx
 * lazy-loads it); the banner and the closed-profile action stay in
 * DirectModelingOverlays.
 */

export interface MoveOverlayValues {
  translation: { x: number; y: number; z: number };
  rotationDeg: { x: number; y: number; z: number };
}

interface MoveOverlayProps {
  bodyName: string;
  values: MoveOverlayValues;
  units: string;
  /** Current gizmo snap increments; null until the first drag. */
  snap: { move: number; rotate: number } | null;
  onChange(values: MoveOverlayValues): void;
  onConfirm(): void;
  onCancel(): void;
  /** Sketch moves translate only; the rotation grid and copy are hidden. */
  hideRotation?: boolean;
  /**
   * The Move feature's name. Omitted for a sketch move, which commits as a
   * sketch translation rather than a named feature, so there is nothing to
   * call. Present for a body move: this overlay is now the only way to make
   * one, so naming at creation has to live here (WF-07).
   */
  name?: string;
  onName?(value: string): void;
  /**
   * Every body the move could target, so choosing one no longer means backing
   * out to a second UI. Omitted when there is nothing to choose between.
   */
  targets?: readonly { bodyId: string; name: string }[];
  targetBodyId?: string;
  onTargetBody?(bodyId: string): void;
  /**
   * M10: add the moved body as a copy and leave the source in place.
   * Omitted for a sketch move, which has no body to copy.
   */
  copy?: boolean;
  onCopy?(value: boolean): void;
  /**
   * M10: how many copies Done stamps, each the same move on from the one
   * before. Offered only while `copy` is on.
   */
  stamps?: number;
  onStamps?(value: number): void;
  /**
   * M10: whether repeated stamps land as one linked History step (true) or
   * one step each (false).
   */
  linked?: boolean;
  onLinked?(value: boolean): void;
  /**
   * M10: Move by two points. `picking` is null while off; otherwise what the
   * first pick snapped to (`from`), or null before it.
   */
  pointPick?: { from: string | null } | null;
  onPointPick?(on: boolean): void;
  /**
   * M10: the point the Move turns about, in document units: a placed pivot
   * or the body's centre. Omitted for a sketch move, which does not turn.
   */
  pivot?: { x: number; y: number; z: number };
  /** M10: place the pivot at `next`, or back on the body's centre (null). */
  onPivot?(next: { x: number; y: number; z: number } | null): void;
  /** M10: whether the gizmo's arrows and centre handle place the pivot. */
  pivotMode?: boolean;
  onPivotMode?(value: boolean): void;
  /**
   * Where this panel publishes a sink for live drag values. The viewport
   * writes the numbers a gesture is producing straight into it, so dragging
   * the gizmo updates these fields without a workspace render. `values` stays
   * authoritative for everything else — typing, switching body, committing.
   */
  liveValuesRef?: MutableRefObject<
    | ((
        translation: MoveOverlayValues['translation'],
        rotationDeg: MoveOverlayValues['rotationDeg'],
        snap: { move: number; rotate: number }
      ) => void)
    | null
  >;
  /**
   * Where the viewport's instruction banner (`MoveInstruction`) listens for
   * the snap a live drag is using. The panel owns the one drag sink above and
   * forwards the snap, so the banner and the panel never disagree mid-drag.
   */
  liveSnapRef?: MutableRefObject<
    ((snap: { move: number; rotate: number }) => void) | null
  >;
}

const MOVE_AXES = ['x', 'y', 'z'] as const;

function sameMoveValues(left: MoveOverlayValues, right: MoveOverlayValues) {
  return MOVE_AXES.every(
    (axis) =>
      Object.is(left.translation[axis], right.translation[axis]) &&
      Object.is(left.rotationDeg[axis], right.rotationDeg[axis])
  );
}

/**
 * A number as a field shows it. A geometry snap lands on `point - pivot`, and
 * that subtraction leaves binary noise (0.19999999999999998) the gizmo's own
 * grid snap no longer does; nine places is far below any modelling tolerance.
 * Negative zero folds to 0, but — as in the gizmo's `snapTo` — an invalid
 * coordinate stays invalid instead of reading as a plausible 0.
 */
function fieldValue(value: number): number {
  const cleaned = Number(value.toFixed(9));
  return cleaned === 0 ? 0 : cleaned;
}

/**
 * A Move/Rotate field that holds what is being typed until it is a number.
 * Bound straight to the value, a lone "-" (an empty number input) read as
 * Number("") === 0 and rewrote the field to 0, so typing -5 produced 05: a
 * move of +5 where the user asked for -5.
 */
function MoveNumberInput({
  value,
  step,
  label,
  onValue
}: {
  value: number;
  step: number;
  label: string;
  onValue(next: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      step={step}
      // A number input cannot hold NaN or Infinity (React warns on NaN; the
      // browser blanks both), so a non-finite value shows as an empty field.
      value={draft ?? (Number.isFinite(value) ? value : '')}
      aria-label={label}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(next)) {
          onValue(next);
        }
      }}
      onKeyDown={(event) => {
        // An emptied or half-typed field holds no value of its own; Enter
        // would apply the previous one, which the field no longer shows.
        if (
          event.key === 'Enter' &&
          draft !== null &&
          (draft.trim() === '' || !Number.isFinite(Number(draft)))
        ) {
          event.preventDefault();
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

/**
 * The Copies count: a whole number from 1 to the most one copy stamps. Like
 * the move fields, it holds a half-typed entry until it is a valid count.
 */
function StampCountInput({
  value,
  onValue
}: {
  value: number;
  onValue(next: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={1}
      max={MAX_TRANSFORM_COPY_STAMPS}
      step={1}
      value={draft ?? value}
      aria-label="Copies"
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const next = Number(raw);
        if (
          raw.trim() !== '' &&
          Number.isInteger(next) &&
          next >= 1 &&
          next <= MAX_TRANSFORM_COPY_STAMPS
        ) {
          onValue(next);
        }
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

export function MoveOverlay({
  bodyName,
  values: committedValues,
  units,
  snap: committedSnap,
  onChange,
  onConfirm,
  onCancel,
  hideRotation,
  name,
  onName,
  targets,
  targetBodyId,
  onTargetBody,
  copy,
  onCopy,
  stamps,
  onStamps,
  linked,
  onLinked,
  pointPick,
  onPointPick,
  pivot,
  onPivot,
  pivotMode,
  onPivotMode,
  liveValuesRef,
  liveSnapRef
}: MoveOverlayProps) {
  // Mirrors `values` except while a drag is streaming, when it runs ahead of
  // workspace state. Keyed off the props so a typed value, a body switch, or a
  // settled drag all re-seed it.
  const [live, setLive] = useState<{
    values: MoveOverlayValues;
    snap: { move: number; rotate: number } | null;
  }>({ values: committedValues, snap: committedSnap });
  const target = targetBodyId ?? bodyName;
  const translationOnly = hideRotation === true;
  const committed = useRef({
    values: committedValues,
    snap: committedSnap,
    target,
    units,
    translationOnly
  });
  useEffect(() => {
    const previous = committed.current;
    // App recreates the values wrapper on unrelated renders (a resize or a
    // save finishing). Only a changed transform, snap or target reseeds the
    // panel; otherwise it would erase the gesture's newer live values.
    if (
      sameMoveValues(previous.values, committedValues) &&
      Object.is(previous.snap?.move, committedSnap?.move) &&
      Object.is(previous.snap?.rotate, committedSnap?.rotate) &&
      previous.target === target &&
      previous.units === units &&
      previous.translationOnly === translationOnly
    )
      return;
    committed.current = {
      values: committedValues,
      snap: committedSnap,
      target,
      units,
      translationOnly
    };
    setLive({ values: committedValues, snap: committedSnap });
  }, [committedValues, committedSnap, target, units, translationOnly]);
  useEffect(() => {
    if (!liveValuesRef) {
      return;
    }
    liveValuesRef.current = (translation, rotationDeg, nextSnap) => {
      setLive({ values: { translation, rotationDeg }, snap: nextSnap });
      liveSnapRef?.current?.(nextSnap);
    };
    return () => {
      liveValuesRef.current = null;
    };
  }, [liveValuesRef, liveSnapRef]);
  const values = live.values;
  const snap = live.snap;
  const unitText = displayLengthName(units as UnitSystem);
  const dirty =
    MOVE_AXES.some((axis) => values.translation[axis] !== 0) ||
    MOVE_AXES.some((axis) => values.rotationDeg[axis] !== 0);
  // Match the shared confirmation guard, including translation-only sketches.
  // A copy in place is a real result (a coincident duplicate to move later),
  // so a copy applies at zero where a plain Move has nothing to do.
  const canApply =
    (dirty || copy === true) &&
    moveHasFiniteValues({
      ...values,
      ...(hideRotation ? { target: 'sketch' as const } : {})
    });
  const setValue = (
    group: 'translation' | 'rotationDeg',
    axis: (typeof MOVE_AXES)[number],
    next: number
  ) => {
    onChange({
      ...values,
      [group]: { ...values[group], [axis]: next }
    });
  };
  // The command is "Move" wherever it is offered (the rail, the drawer, the
  // search); the card called itself "Move / Rotate". Rotation is still here,
  // on the gizmo's rings and under Options.
  const title = 'Move';
  // In the compact sheet the bar is its tray (U12 slice 4), as every
  // in-place command's: the step, Options, Cancel and Done in one pinned row.
  const tray = useCompactCommandTray();
  const keypadSlot = useCompactKeypadSlot();
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const step = pointPick
    ? pointPick.from === null
      ? 'From point'
      : 'To point'
    : pivotMode
      ? 'Pivot'
      : 'Drag';
  const cancelButton = (
    <button
      type="button"
      className="in-place-command-cancel"
      onClick={onCancel}
      aria-keyshortcuts="Escape"
    >
      <X size={tray ? 20 : 14} aria-hidden="true" />
      {tray ? <span className="visually-hidden">Cancel</span> : 'Cancel'}
      {tray ? null : <kbd aria-hidden="true">Esc</kbd>}
    </button>
  );
  const doneButton = (
    <button
      type="submit"
      className="in-place-command-done"
      disabled={!canApply}
      aria-keyshortcuts="Enter"
    >
      <Check size={tray ? 20 : 14} aria-hidden="true" />
      Done
      {tray ? null : <kbd aria-hidden="true">Enter</kbd>}
    </button>
  );
  return (
    <form
      className={`in-place-command move-command${tray ? ' is-tray' : ''}`}
      aria-label="Move controls"
      onSubmit={(event) => {
        event.preventDefault();
        if (canApply) {
          onConfirm();
        }
      }}
    >
      {tray ? (
        <div className="compact-tray-row">
          <span className="compact-tray-tool" aria-hidden="true">
            {TOOL_META.transform.icon}
          </span>
          <span className="compact-step-chip" aria-hidden="true">
            {step}
          </span>
          <button
            type="button"
            className="compact-tray-button compact-tray-options"
            aria-label={`${title} options`}
            aria-expanded={optionsOpen}
            aria-controls={optionsId}
            title="Options"
            onClick={() => {
              const details = optionsRef.current;
              if (details) details.open = !details.open;
            }}
          >
            <SlidersHorizontal size={20} aria-hidden="true" />
          </button>
          {cancelButton}
          {doneButton}
        </div>
      ) : null}
      {tray ? (
        // The keypad, when a value's chip opens it: under the pinned row.
        <div
          ref={keypadSlot}
          className="compact-keypad-host"
          {...{ [SHEET_OVERLAY_ATTRIBUTE]: '' }}
        />
      ) : null}
      <span className="in-place-command-title">{title}</span>
      {/* The same state pill as every other command's: empty until there is
          a move to preview. */}
      <span className="in-place-command-state">{dirty ? 'Preview' : ''}</span>
      {/* The one place the step is said: it was also a toast, and the
          toast's guidance (rings, Shift) lives here now. */}
      <span className="in-place-command-hint" title={bodyName}>
        {pointPick ? (
          pointPick.from === null ? (
            <>
              Move <span className="move-target-name">{bodyName}</span> by two
              points · pick the point to move from
            </>
          ) : (
            <>From {pointPick.from} · pick the point to move it to</>
          )
        ) : pivotMode ? (
          <>
            Pivot of <span className="move-target-name">{bodyName}</span> · drag
            the handle onto a corner or centre · Shift moves freely
          </>
        ) : (
          <>
            {copy
              ? (stamps ?? 1) > 1
                ? `${stamps} copies of `
                : 'A copy of '
              : ''}
            <span className="move-target-name">{bodyName}</span> ·{' '}
            {hideRotation ? 'drag the arrows' : 'drag the arrows or rings'} ·
            Shift moves freely
          </>
        )}
      </span>
      {/* M10: translate by two picked points, snapped to corners, midpoints
          and centres; the second pick sets the move and ends the pick. */}
      {onPointPick ? (
        <button
          type="button"
          className="move-two-points"
          aria-pressed={pointPick != null}
          title="Move from one picked point to another"
          onClick={() => onPointPick(pointPick == null)}
        >
          <Spline size={14} aria-hidden="true" />
          Two points
        </button>
      ) : null}
      {/* M10: the pivot handle. While it is on, the arrows and the centre
          ball carry the turn's centre and the body stays where it is. */}
      {pivot && onPivotMode ? (
        <button
          type="button"
          className="move-pivot-toggle"
          aria-pressed={pivotMode === true}
          title="Place the point the rings turn about"
          onClick={() => onPivotMode(!pivotMode)}
        >
          <LocateFixed size={14} aria-hidden="true" />
          Pivot
        </button>
      ) : null}
      {/* The gizmo is the Move: its exact numbers, name, body and copy are
          rare enough to sit behind Options, as every in-place command's. */}
      <details
        ref={optionsRef}
        id={optionsId}
        className="in-place-command-options"
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setOptionsOpen(open);
          if (open && tray) raiseCompactSheet(event.currentTarget, 'half');
        }}
      >
        <summary
          {...(tray
            ? { 'aria-hidden': true, tabIndex: -1 }
            : { 'aria-label': `${title} options`, title: 'Options' })}
        >
          <SlidersHorizontal size={14} aria-hidden="true" />
          <span>Options</span>
        </summary>
        <div className="in-place-command-options-panel move-options">
          {name !== undefined && onName ? (
            <label className="field move-name">
              <span>Name</span>
              <input
                value={name}
                onChange={(event) => onName(event.target.value)}
              />
            </label>
          ) : null}
          {targets && targets.length > 1 && onTargetBody ? (
            <label className="field move-target">
              <span>Body</span>
              <select
                value={targetBodyId ?? ''}
                onChange={(event) => onTargetBody(event.target.value)}
              >
                {targets.map((target) => (
                  <option key={target.bodyId} value={target.bodyId}>
                    {target.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="move-grid" role="group" aria-label="Translation">
            {MOVE_AXES.map((axis) => (
              <label key={`t-${axis}`}>
                <span className={`move-axis move-axis-${axis}`}>
                  d{axis.toUpperCase()}
                </span>
                <span className="extrude-distance-input">
                  <MoveNumberInput
                    step={snap?.move ?? 1}
                    value={fieldValue(values.translation[axis])}
                    label={`Move ${axis.toUpperCase()} in ${units}`}
                    onValue={(next) => setValue('translation', axis, next)}
                  />
                  <b>{unitText}</b>
                </span>
              </label>
            ))}
          </div>
          {/* Not rendered rather than `hidden`: `.move-grid { display: grid }`
          beat the attribute, so a sketch move showed rotation fields whose
          values its commit silently dropped. */}
          {hideRotation ? null : (
            <div className="move-grid" role="group" aria-label="Rotation">
              {MOVE_AXES.map((axis) => (
                <label key={`r-${axis}`}>
                  <span className={`move-axis move-axis-${axis}`}>
                    r{axis.toUpperCase()}
                  </span>
                  <span className="extrude-distance-input">
                    <MoveNumberInput
                      step={snap?.rotate ?? 1}
                      value={fieldValue(values.rotationDeg[axis])}
                      label={`Rotate ${axis.toUpperCase()} in degrees`}
                      onValue={(next) => setValue('rotationDeg', axis, next)}
                    />
                    <b>°</b>
                  </span>
                </label>
              ))}
            </div>
          )}
          {pivot && onPivot ? (
            <div className="move-grid" role="group" aria-label="Pivot">
              {MOVE_AXES.map((axis) => (
                <label key={`p-${axis}`}>
                  <span className={`move-axis move-axis-${axis}`}>
                    p{axis.toUpperCase()}
                  </span>
                  <span className="extrude-distance-input">
                    <MoveNumberInput
                      step={snap?.move ?? 1}
                      value={fieldValue(pivot[axis])}
                      label={`Pivot ${axis.toUpperCase()} in ${units}`}
                      onValue={(next) => onPivot({ ...pivot, [axis]: next })}
                    />
                    <b>{unitText}</b>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {pivot && onPivot ? (
            <button
              type="button"
              className="move-pivot-reset"
              onClick={() => onPivot(null)}
            >
              Pivot to body centre
            </button>
          ) : null}
          {copy !== undefined && onCopy ? (
            <label className="field transform-copy">
              <input
                type="checkbox"
                checked={copy}
                onChange={(event) => onCopy(event.target.checked)}
              />
              <span>Keep original</span>
            </label>
          ) : null}
          {copy && onStamps ? (
            <label className="field transform-stamps">
              <span>Copies</span>
              <StampCountInput value={stamps ?? 1} onValue={onStamps} />
            </label>
          ) : null}
          {copy && (stamps ?? 1) > 1 && onLinked ? (
            <label className="field transform-copy transform-stamps-linked">
              <input
                type="checkbox"
                checked={linked !== false}
                onChange={(event) => onLinked(event.target.checked)}
              />
              <span>Link copies (one History step)</span>
            </label>
          ) : null}
        </div>
      </details>
      {tray ? null : cancelButton}
      {tray ? null : doneButton}
    </form>
  );
}
