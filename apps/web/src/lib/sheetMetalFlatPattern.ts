/**
 * M16 slice 4: the flat-pattern view's bend table, its CSV and the warning
 * for later features that changed the sheet.
 */
import type { UnitSystem } from '@openzcad/shared';
import {
  flatPatternBendLabels,
  formatFlatPatternNumber,
  type SheetMetalFlatPattern
} from '@openzcad/kernel-adapter/sheet-metal-flat-pattern';
import { unitLabel } from './measurements';

/** One row of the bend table, formatted for display. */
export interface BendTableRow {
  number: string;
  direction: 'Up' | 'Down';
  angle: string;
  insideRadius: string;
  kFactor: string;
  bendAllowance: string;
  /** `—` at 180°, where there is no finite setback. */
  bendDeduction: string;
  lineLength: string;
}

/**
 * The bend table in document units, formatted as the DXF notes are (the
 * app's three decimals, at least four significant digits). Bends
 * count from 1 in the pattern's order; a bend whose line crosses the sheet
 * in several pieces numbers them `2.1`, `2.2`, … along its line (as the DXF
 * notes do).
 */
export function bendTableRows(
  pattern: Pick<SheetMetalFlatPattern, 'bends'>
): BendTableRow[] {
  const labels = flatPatternBendLabels(pattern);
  return pattern.bends.map((bend, index) => {
    return {
      number: labels[index]!,
      direction: bend.direction === 'up' ? 'Up' : 'Down',
      angle: formatFlatPatternNumber(bend.angleDeg),
      insideRadius: formatFlatPatternNumber(bend.insideRadius),
      kFactor: formatFlatPatternNumber(bend.kFactor),
      bendAllowance: formatFlatPatternNumber(bend.bendAllowance),
      bendDeduction:
        bend.bendDeduction === null
          ? '—'
          : formatFlatPatternNumber(bend.bendDeduction),
      lineLength: formatFlatPatternNumber(bend.lineLength)
    };
  });
}

/** Column headings, with the unit each length column is in. */
export function bendTableHeadings(units: UnitSystem): string[] {
  const length = unitLabel('length', units);
  return [
    'No.',
    'Direction',
    'Angle (°)',
    `Inside radius (${length})`,
    'K-factor',
    `Bend allowance (${length})`,
    `Bend deduction (${length})`,
    `Line length (${length})`
  ];
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** The bend table as CSV: a header row, then one row per bend line. */
export function bendTableCsv(
  pattern: Pick<SheetMetalFlatPattern, 'bends'>,
  units: UnitSystem
): string {
  const rows = bendTableRows(pattern).map((row) => [
    row.number,
    row.direction,
    row.angle,
    row.insideRadius,
    row.kFactor,
    row.bendAllowance,
    row.bendDeduction,
    row.lineLength
  ]);
  return `${[bendTableHeadings(units), ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')}\r\n`;
}

/**
 * The plain warning for later features that change the sheet: "2 later
 * features change this body; the flat pattern shows the sheet before them."
 */
export function flatPatternChangedWarning(
  changedBy: SheetMetalFlatPattern['changedBy']
): string | null {
  if (changedBy.length === 0) return null;
  const count = changedBy.length;
  return `${count} later ${count === 1 ? 'feature changes' : 'features change'} this body; the flat pattern shows the sheet before ${count === 1 ? 'it' : 'them'}.`;
}
