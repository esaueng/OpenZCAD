import {
  millimetresPerUnit,
  storedTopologyReferenceError,
  type UnitSystem
} from '@openzcad/shared';
import type { ConversionReferenceValue } from './units-reference-map';

/**
 * I03 stored-unit conversion, phase 5: the structural checks on a recorded
 * `units.convert` payload that need no document. Replay
 * (`unitsConvertPayloadProblem`) and the stored-log gate
 * (`assertDocumentContentCommandSchema`) share them, so a log the gate lets
 * open is one replay can read. A leaf module: the content-schema gate
 * imports it without importing the transform.
 */

const CONVERTIBLE: readonly UnitSystem[] = ['mm', 'cm', 'inch'];

/** The exact factor a conversion between two units records. */
export function unitsConvertFactor(
  from: UnitSystem,
  to: UnitSystem
): [number, number] {
  return [millimetresPerUnit(from), millimetresPerUnit(to)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` is one of the {@link ConversionReferenceValue} kinds a
 * site can store: a well-formed v5 face or edge reference (by
 * `storedTopologyReferenceError`, the validator stored drawing references
 * use), a hash or end index, a profile id, or an edge-run flag. The one
 * guard every payload validator shares, for `from` and `to` alike.
 */
export function isConversionReferenceValue(
  value: unknown
): value is ConversionReferenceValue {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'boolean') return true;
  return (
    isRecord(value) &&
    (value.kind === 'face' || value.kind === 'edge') &&
    storedTopologyReferenceError(value, value.kind) === null
  );
}

/**
 * Why `input` is not a well-formed `units.convert` payload: the units, the
 * exact factor, and every reference entry's `from` and `to`. Pass
 * `documentUnits` to also require that the conversion starts from them
 * (replay); the stored-log gate omits it, since a log entry's document unit
 * is the one its predecessors leave.
 */
export function unitsConvertPayloadShapeProblem(
  input: unknown,
  documentUnits?: UnitSystem
): string | undefined {
  if (!isRecord(input)) return 'The conversion payload is not an object.';
  const { from, to, factor, references } = input;
  if (!CONVERTIBLE.includes(from as UnitSystem))
    return `The conversion's source unit ${JSON.stringify(from)} is not millimetres, centimetres or inches.`;
  if (!CONVERTIBLE.includes(to as UnitSystem))
    return `The conversion's target unit ${JSON.stringify(to)} is not millimetres, centimetres or inches.`;
  if (from === to) return 'The conversion does not change the unit.';
  if (documentUnits !== undefined && documentUnits !== from)
    return `The conversion is from ${String(from)}, but the document is stored in ${documentUnits}.`;
  const [N, D] = unitsConvertFactor(from as UnitSystem, to as UnitSystem);
  if (
    !Array.isArray(factor) ||
    factor.length !== 2 ||
    !Object.is(factor[0], N) ||
    !Object.is(factor[1], D)
  )
    return `The conversion's factor ${JSON.stringify(factor)} is not ${N} / ${D}.`;
  if (!isRecord(references))
    return "The conversion's reference map is not an object.";
  for (const [pointer, entry] of Object.entries(references))
    if (
      !pointer.startsWith('/') ||
      !isRecord(entry) ||
      !isConversionReferenceValue(entry.from) ||
      !isConversionReferenceValue(entry.to)
    )
      return `The conversion's reference map holds an invalid entry at ${JSON.stringify(pointer)}.`;
  return undefined;
}
