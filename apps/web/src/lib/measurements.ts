/**
 * The running tape View mode's measure tool writes to.
 *
 * Measurements are read off the selection rather than authored, so the value is
 * already formatted by the time it lands here — this module owns what makes two
 * measurements the same, what the list does when it grows, and how it leaves
 * for a spreadsheet.
 */

export type MeasurementKind =
  | 'edge'
  | 'edge-total'
  | 'hole'
  | 'diameter'
  | 'body';

export interface Measurement {
  /** Stable per picked entity, so re-picking cannot double up a row. */
  key: string;
  kind: MeasurementKind;
  /** What was measured, e.g. `Bracket · Edge 4`. */
  label: string;
  /** The formatted value, units included, e.g. `84 mm`. */
  value: string;
  /** A second figure worth carrying, e.g. a body's volume beside its size. */
  note?: string;
}

/**
 * How many rows the dock keeps. Long enough that a real inspection pass never
 * hits it, short enough that a stuck selection cannot grow the list forever.
 */
export const MEASUREMENT_LIMIT = 50;

/**
 * Adds a measurement unless the same entity is already on the tape. Re-picking
 * an edge to look at it again is normal; getting a second identical row for it
 * is not. A changed value for the same key replaces the old row in place, so a
 * rebuild that resizes the edge updates the tape rather than duplicating it.
 */
export function appendMeasurement(
  list: readonly Measurement[],
  next: Measurement
): Measurement[] {
  const at = list.findIndex((entry) => entry.key === next.key);
  if (at !== -1) {
    const existing = list[at]!;
    if (existing.value === next.value && existing.note === next.note) {
      return list as Measurement[];
    }
    const replaced = [...list];
    replaced[at] = next;
    return replaced;
  }
  const appended = [...list, next];
  return appended.length > MEASUREMENT_LIMIT
    ? appended.slice(appended.length - MEASUREMENT_LIMIT)
    : appended;
}

/** Tab-separated, which is what spreadsheets accept straight from a paste. */
export function measurementsToText(list: readonly Measurement[]): string {
  return list
    .map((entry) =>
      entry.note
        ? `${entry.label}\t${entry.value}\t${entry.note}`
        : `${entry.label}\t${entry.value}`
    )
    .join('\n');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function measurementsToCsv(list: readonly Measurement[]): string {
  const rows = list.map((entry) =>
    [entry.kind, entry.label, entry.value, entry.note ?? '']
      .map(csvCell)
      .join(',')
  );
  return ['kind,label,value,note', ...rows].join('\n');
}
