import { createContext, useContext, type ReactNode } from 'react';
import {
  convertLength,
  displayLengthName,
  type UnitSystem
} from '@openzcad/shared';
import { formatNumber } from './model';

/**
 * I03 display units in the workspace. The open document stores lengths in
 * its own units and shows them in its display units (`documentDisplayUnits`).
 * Fields that take a length read the display unit from here rather than from
 * a prop threaded through every form: the value they hand back is always in
 * the stored units, so no caller learns about the conversion.
 *
 * Absent (outside a workspace, or in a test that renders a field alone), the
 * field shows its stored units, exactly as before display units existed.
 */
const DisplayUnitsContext = createContext<UnitSystem | null>(null);

export function DisplayUnitsProvider({
  units,
  children
}: {
  units: UnitSystem | null;
  children: ReactNode;
}) {
  return (
    <DisplayUnitsContext.Provider value={units}>
      {children}
    </DisplayUnitsContext.Provider>
  );
}

/** The unit lengths are shown in, or `stored` when none is chosen. */
export function useDisplayUnits(stored: UnitSystem): UnitSystem {
  return useContext(DisplayUnitsContext) ?? stored;
}

const PLAIN_NUMBER = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?\s*$/i;

/** Whether `text` is a bare number, which display units reinterpret. */
export function isPlainLengthNumber(text: string): boolean {
  return PLAIN_NUMBER.test(text);
}

/**
 * A converted length as a field writes it: enough digits that 1/16 in reads
 * `0.0625`, never the float noise of a conversion (`0.7874015748031497`
 * stays, `0.09999999999999999` reads `0.1`).
 */
export function fieldNumberText(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/**
 * The text a length field shows for a stored `value`. A bare number is a
 * stored-unit length, so it is shown converted into `shown`; anything else
 * (an expression, or a value that names its own unit) is shown as written,
 * because it means the same in every display unit.
 */
export function shownLengthText(
  value: string,
  stored: UnitSystem,
  shown: UnitSystem
): string {
  if (stored === shown || !isPlainLengthNumber(value)) return value;
  return fieldNumberText(convertLength(Number(value), stored, shown));
}

/**
 * The text a length field stores for what was typed. A bare number is read
 * in the display unit and stored as the same length in the stored units, at
 * full precision: a plain number is what every builder resolves, where a
 * unit suffix is not accepted on every path. Anything else is stored as
 * typed: there bare numbers and parameters keep their stored-unit meaning
 * and an explicit unit suffix is honoured as always.
 */
export function storedLengthText(
  typed: string,
  stored: UnitSystem,
  shown: UnitSystem
): string {
  if (stored === shown || !isPlainLengthNumber(typed)) return typed;
  return String(convertLength(Number(typed), shown, stored));
}

/** A stored-unit length written in `shown`, with its unit: `0.787 in`. */
export function formatShownLength(
  value: number,
  stored: UnitSystem,
  shown: UnitSystem
): string {
  return `${formatNumber(convertLength(value, stored, shown))} ${displayLengthName(shown)}`;
}
