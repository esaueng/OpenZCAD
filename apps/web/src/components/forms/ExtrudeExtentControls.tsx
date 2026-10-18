import type { ExtrudeEndCondition, ThroughAllSide } from '@openzcad/shared';

const THROUGH_ALL_SIDES: { value: ThroughAllSide; label: string }[] = [
  { value: 'forward', label: 'Along the sketch normal' },
  { value: 'backward', label: 'Against the sketch normal' },
  { value: 'both', label: 'Both sides' }
];

export interface ExtrudeExtentControlsProps {
  endCondition: ExtrudeEndCondition;
  throughAllSide: ThroughAllSide;
  onChange(patch: {
    endCondition?: ExtrudeEndCondition;
    throughAllSide?: ThroughAllSide;
  }): void;
}

/**
 * F01's extent choice for an existing cut. A module of its own, loaded only
 * when that card opens, because the extrude editor rides in the entry chunk.
 */
export default function ExtrudeExtentControls({
  endCondition,
  throughAllSide,
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
          <option value="through-all">Through all</option>
        </select>
      </label>
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
