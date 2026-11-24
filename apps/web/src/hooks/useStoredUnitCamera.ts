import { useEffect, useRef } from 'react';
import type { UnitSystem } from '@openzcad/shared';
import { storedUnitFactor } from '../lib/storedUnitView';

export { scaledCameraPose } from '../lib/storedUnitView';

/**
 * I03: keeps the camera on the same view when the open project's stored
 * unit changes under it: a stored-unit conversion, its undo or redo, or a
 * restore of the safety checkpoint. The camera is otherwise kept in
 * document units, so a box converted from millimetres to inches would
 * shrink to a speck 25.4 times further away, and the scale bar would read
 * "20 in" where it read "20 mm".
 *
 * Calls `onUnitsChanged` with k = mm(old) / mm(new), and the old and new
 * units, once per change of `units` while `projectId` stays the same;
 * opening another project never does.
 */
export function useStoredUnitCamera(
  projectId: string | null,
  units: UnitSystem | null,
  onUnitsChanged: (factor: number, from: UnitSystem, to: UnitSystem) => void
): void {
  const shown = useRef<{ projectId: string; units: UnitSystem } | null>(null);
  const callback = useRef(onUnitsChanged);
  callback.current = onUnitsChanged;
  useEffect(() => {
    const last = shown.current;
    shown.current =
      projectId === null || units === null ? null : { projectId, units };
    if (
      last === null ||
      projectId === null ||
      units === null ||
      last.projectId !== projectId ||
      last.units === units
    )
      return;
    callback.current(storedUnitFactor(last.units, units), last.units, units);
  }, [projectId, units]);
}
