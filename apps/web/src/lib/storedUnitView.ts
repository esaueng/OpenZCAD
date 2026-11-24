import {
  UNIT_TO_MM,
  millimetresPerUnit,
  type UnitSystem
} from '@openzcad/shared';
import type {
  SectionViewSettings,
  ViewportCameraState
} from '@openzcad/viewport';

/**
 * I03: the view state kept outside the document (the camera, a section cut,
 * a saved view) is in the project's stored unit, so a stored-unit
 * conversion, its undo or redo, or a checkpoint restore rescales it by the
 * same k as the model. These are the pure pieces of that.
 */

/** Whether `value` names a stored unit (a record read back from storage). */
export function isStoredUnit(value: unknown): value is UnitSystem {
  return typeof value === 'string' && Object.hasOwn(UNIT_TO_MM, value);
}

/** k = mm(from) / mm(to): what every stored length is multiplied by. */
export function storedUnitFactor(from: UnitSystem, to: UnitSystem): number {
  return from === to ? 1 : millimetresPerUnit(from) / millimetresPerUnit(to);
}

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
 * A section cut for a model whose stored numbers were multiplied by
 * `factor`: the same plane through the same part. The offset is a length
 * along the plane's axis; the plane and its direction are unit-free.
 */
export function scaledSectionView(
  section: SectionViewSettings,
  factor: number
): SectionViewSettings {
  return { ...section, offset: section.offset * factor };
}
