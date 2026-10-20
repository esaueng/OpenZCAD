import type { ExtrudeEndCondition, ThroughAllSide } from '@openzcad/shared';

const THROUGH_ALL_SIDES: { value: ThroughAllSide; label: string }[] = [
  { value: 'forward', label: 'Along the sketch normal' },
  { value: 'backward', label: 'Against the sketch normal' },
  { value: 'both', label: 'Both sides' }
];

export interface ExtrudeExtentControlsProps {
  endCondition: ExtrudeEndCondition;
  throughAllSide: ThroughAllSide;
  /** Through all needs an explicit cut; Distance and To face are always offered. */
  offersThroughAll: boolean;
  /**
   * F01 (v29) to-face: what the target reads as ("Ceiling · face"), or null
   * with no face picked yet; `unresolved` when the stored face no longer
   * resolves, which only a re-pick fixes.
   */
  toFace: {
    label: string | null;
    unresolved: boolean;
    /** Why the picked face cannot be reached from this sketch, if it cannot. */
    problem: string | null;
    armed: boolean;
    onPick(): void;
  };
  onChange(patch: {
    endCondition?: ExtrudeEndCondition;
    throughAllSide?: ThroughAllSide;
  }): void;
}

/** F01's extent choice in the extrude editor. */
export default function ExtrudeExtentControls({
  endCondition,
  throughAllSide,
  offersThroughAll,
  toFace,
  onChange
}: ExtrudeExtentControlsProps) {
  return (
    <>
      <label className="field">
        <span>Extent</span>
        <select
          aria-label="Extent"
          value={endCondition}
          onChange={(event) =>
            onChange({
              endCondition: event.target.value as ExtrudeEndCondition
            })
          }
        >
          <option value="blind">Distance</option>
          <option value="to-face">To face</option>
          {offersThroughAll ? (
            <option value="through-all">Through all</option>
          ) : null}
        </select>
      </label>
      {endCondition === 'to-face' ? (
        <div className="extrude-to-face" role="group" aria-label="Target face">
          <p
            className={toFace.unresolved ? 'form-error' : 'muted'}
            aria-live="polite"
          >
            {toFace.armed
              ? 'Click a planar face parallel to the sketch · Esc cancels.'
              : toFace.unresolved
                ? `Target face is unresolved${toFace.label ? ` (${toFace.label})` : ''}: it no longer exists here. Re-pick a face.`
                : toFace.label
                  ? `Up to ${toFace.label}`
                  : 'No face picked yet.'}
          </p>
          {toFace.problem && !toFace.armed ? (
            <p className="form-error">{toFace.problem}</p>
          ) : null}
          <button
            type="button"
            className="secondary"
            aria-pressed={toFace.armed}
            onClick={toFace.onPick}
          >
            {toFace.label || toFace.unresolved ? 'Re-pick face' : 'Pick face'}
          </button>
          <p className="muted">
            Reaches the face wherever it moves later; the face is found again by
            its identity on every rebuild.
          </p>
        </div>
      ) : null}
      {endCondition === 'through-all' ? (
        <>
          <label className="field">
            <span>Direction</span>
            <select
              aria-label="Through-all direction"
              value={throughAllSide}
              onChange={(event) =>
                onChange({
                  throughAllSide: event.target.value as ThroughAllSide
                })
              }
            >
              {THROUGH_ALL_SIDES.map((side) => (
                <option key={side.value} value={side.value}>
                  {side.label}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Cuts through the whole target, however its size or position changes
            later.
          </p>
        </>
      ) : null}
    </>
  );
}
