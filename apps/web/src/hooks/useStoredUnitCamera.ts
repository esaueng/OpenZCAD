import { useEffect, useRef } from 'react';
import { millimetresPerUnit, type UnitSystem } from '@openzcad/shared';
import type { ViewportCameraState } from '@openzcad/viewport';

/**
 * A camera pose for a model whose stored numbers were multiplied by
 * `factor`: the same view of the same part. Position, target and the
 * orthographic frustum's half-height are lengths in document units, so they
 * scale; the orthographic zoom multiplies the half-height, and the field of
 * view and up vector are unit-free, so they stay.
 */
export function scaledCameraPose(
  pose: ViewportCameraState,
  factor: number
): ViewportCameraState {
  const scale = ([x, y, z]: readonly [number, number, number]) =>
    [x * factor, y * factor, z * factor] as [number, number, number];
  return {
    ...pose,
    position: scale(pose.position),
    target: scale(pose.target),
    ...(pose.orthographicHalfHeight === undefined
      ? {}
      : { orthographicHalfHeight: pose.orthographicHalfHeight * factor })
  };
}

/**
 * I03: keeps the camera on the same view when the open project's stored
 * unit changes under it: a stored-unit conversion, its undo or redo, or a
 * restore of the safety checkpoint. The camera is otherwise kept in
 * document units, so a box converted from millimetres to inches would
 * shrink to a speck 25.4 times further away, and the scale bar would read
 * "20 in" where it read "20 mm".
 *
 * Calls `onUnitsChanged` with k = mm(old) / mm(new) once per change of
 * `units` while `projectId` stays the same; opening another project never
 * does.
 */
export function useStoredUnitCamera(
  projectId: string | null,
  units: UnitSystem | null,
  onUnitsChanged: (factor: number) => void
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
    callback.current(
      millimetresPerUnit(last.units) / millimetresPerUnit(units)
    );
  }, [projectId, units]);
}
