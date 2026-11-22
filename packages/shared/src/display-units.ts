import type { ProjectDocument, UnitSystem } from './index';
import { millimetresPerUnit } from './index';

/**
 * I03 display units (schema v148). A document stores every length in
 * `units`, the unit it was created in, and shows and takes lengths in
 * `displayUnits`. Switching the display unit converts what is shown and how
 * a plain typed number is read; it never rewrites a stored length, so the
 * model, its persisted references and every export stay exactly as they
 * were. Explicit whole-document conversion of the stored values stays the
 * deferred part of I03.
 */

const DISPLAY_UNIT_SYSTEMS: readonly UnitSystem[] = ['mm', 'cm', 'm', 'inch'];

/** Why a stored `displayUnits` cannot be kept, or null. */
export function displayUnitsError(value: unknown): string | null {
  return typeof value === 'string' &&
    (DISPLAY_UNIT_SYSTEMS as readonly string[]).includes(value)
    ? null
    : 'The display units must be mm, cm, m or inch.';
}

/** The unit `document` shows lengths in: its display units, else its own. */
export function documentDisplayUnits(
  document: Pick<ProjectDocument, 'units' | 'displayUnits'>
): UnitSystem {
  const { displayUnits } = document;
  return displayUnits !== undefined && displayUnitsError(displayUnits) === null
    ? displayUnits
    : document.units;
}

/** `value`, a length in `from`, expressed in `to`. Exact when they match. */
export function convertLength(
  value: number,
  from: UnitSystem,
  to: UnitSystem
): number {
  if (from === to) return value;
  return (value * millimetresPerUnit(from)) / millimetresPerUnit(to);
}

/** How a unit is named in a sentence: "Show lengths in inches". */
export const UNIT_SYSTEM_WORDS: Readonly<Record<UnitSystem, string>> = {
  mm: 'millimeters',
  cm: 'centimeters',
  m: 'meters',
  inch: 'inches'
};

/** How a unit is named in a menu. */
export const UNIT_SYSTEM_NAMES: Readonly<Record<UnitSystem, string>> = {
  mm: 'Millimeters (mm)',
  cm: 'Centimeters (cm)',
  m: 'Meters (m)',
  inch: 'Inches (in)'
};
