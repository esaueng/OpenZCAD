import { createContext, useContext, type ReactNode } from 'react';
import {
  convertLength,
  displayLengthName,
  documentDisplayUnits,
  type ProjectDocument,
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

/**
 * I03: read-only figures in the display unit. A length scales once, an area
 * twice, a volume three times and a unit-density moment of inertia five
 * times; `unit` names the shown unit for each, as the measurement dock does.
 */
export interface LengthReadout {
  stored: UnitSystem;
  shown: UnitSystem;
  /** A stored-unit length in the shown unit. */
  length(value: number): number;
  /** A stored-unit quantity of length to the `power` in the shown unit. */
  power(value: number, power: number): number;
  /** The shown unit's symbol: `in`, `mm`. */
  symbol: string;
}

export function lengthReadout(
  stored: UnitSystem,
  shown: UnitSystem = stored
): LengthReadout {
  const scale = convertLength(1, stored, shown);
  return {
    stored,
    shown,
    length: (value) => (scale === 1 ? value : value * scale),
    power: (value, power) => (scale === 1 ? value : value * scale ** power),
    symbol: displayLengthName(shown)
  };
}

/** {@link lengthReadout} in the open document's display unit. */
export function useLengthReadout(stored: UnitSystem): LengthReadout {
  return lengthReadout(stored, useDisplayUnits(stored));
}

/**
 * I03: a stored-unit length as a sentence writes it, in the document's
 * display unit: `0.787 in`. Without a document it is the bare number.
 */
export function formatDocumentLength(
  document: Pick<ProjectDocument, 'units' | 'displayUnits'> | null | undefined,
  value: number
): string {
  if (!document) return formatNumber(value);
  return formatShownLength(
    value,
    document.units,
    documentDisplayUnits(document)
  );
}

/**
 * The decimals that tell two hundredths of the stored unit apart once
 * multiplied by `scale` (the stored-to-shown factor): 2 when the document is
 * shown in its own unit, 4 for millimetres shown in inches, 5 in metres.
 * `formatDocumentHundredths` and the offset chip's limit
 * (`offsetLimitChipText`) share it, so the keypad and the chip state one
 * limit the same way.
 */
export function storedHundredthDecimals(scale: number): number {
  const resolution = Math.abs(0.01 * scale);
  if (!Number.isFinite(resolution) || resolution === 0) return 2;
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(resolution) - 1e-9)));
}

/**
 * A stored-unit length that stands for a hundredth of the stored unit (an
 * offset, its limit, a Keep value, a Total) in the document's display unit,
 * with just the decimals that tell two such hundredths apart: 17.6 and
 * 17.61 mm read 0.0176 and 0.01761 m, 0.6929 and 0.6933 in, and an inch
 * limit of -0.2519685 reads -6.4 mm. `formatDocumentLength`'s thousandths
 * would merge the metre pair and drop the sign of a small limit.
 */
export function formatDocumentHundredths(
  document: Pick<ProjectDocument, 'units' | 'displayUnits'> | null | undefined,
  value: number
): string {
  const stored = document?.units ?? 'mm';
  const shown = document ? documentDisplayUnits(document) : stored;
  const decimals = storedHundredthDecimals(convertLength(1, stored, shown));
  const number = Number(convertLength(value, stored, shown).toFixed(decimals));
  const text = String(Object.is(number, -0) ? 0 : number);
  return document ? `${text} ${displayLengthName(shown)}` : text;
}

/**
 * I03: a stored value handed back to a field that reads plain numbers in
 * the display unit, such as a refusal's proved size ("Try 2.5 mm") put into
 * the in-place Options panel. A length is converted; an angle or a count is
 * the same number in every unit.
 */
export function displayEntryText(
  value: number,
  isLength: boolean,
  stored: UnitSystem,
  shown: UnitSystem
): string {
  return String(isLength ? convertLength(value, stored, shown) : value);
}
