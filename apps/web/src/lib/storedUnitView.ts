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

/**
 * The unit view state written before it recorded its unit (a remembered
 * view, a saved view) is in, when a project opens:
 *
 * - the unit this device last held the project in, when known;
 * - else `'unknown'` when the project may have been converted since: its
 *   command log shows a conversion, or there is no history to rule one out
 *   (a share link serves the model without its log, and an empty log
 *   proves nothing);
 * - else the project's own unit: its full history shows no conversion.
 *
 * `'unknown'` state is never read as, or stamped with, a guessed unit.
 */
export function legacyViewUnits(input: {
  previousUnits: UnitSystem | undefined;
  units: UnitSystem;
  commandLog: readonly { kind: string }[];
  /** False for a share without history, whose log was stripped. */
  historyAvailable: boolean;
}): UnitSystem | 'unknown' {
  if (input.previousUnits) return input.previousUnits;
  if (
    !input.historyAvailable ||
    input.commandLog.length === 0 ||
    input.commandLog.some((command) => command.kind === 'units.convert')
  )
    return 'unknown';
  return input.units;
}
