import {
  UNIT_TO_MM,
  type SketchObjectData,
  type UnitlessImportUnits,
  type UnitSystem
} from '@openzcad/shared';

/**
 * Reading files that do not say what their numbers mean.
 *
 * STL, OBJ and PLY carry bare coordinates, and a DXF without `$INSUNITS`
 * does too. Before this choice existed a mesh was always read as
 * millimetres and such a DXF as the project's units — right most of the
 * time, and 25.4 times wrong for an inch part with no sign of it on screen.
 * The import now asks (or applies the unit the user settled on), and the
 * historical reading is the preselected answer.
 */

/** The units a unitless file can be read in, smallest first. */
export const IMPORT_UNIT_CHOICES: readonly UnitSystem[] = [
  'mm',
  'cm',
  'm',
  'inch'
];

export const IMPORT_UNIT_LABELS: Record<UnitSystem, string> = {
  mm: 'Millimeters',
  cm: 'Centimeters',
  m: 'Meters',
  inch: 'Inches'
};

const UNIT_SUFFIX: Record<UnitSystem, string> = {
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  inch: 'in'
};

/** The file kinds whose numbers carry no unit at all. */
export type UnitlessImportKind = 'mesh' | 'dxf';

/** True for the mesh formats that never state a unit. */
export function isUnitlessMeshFileName(fileName: string): boolean {
  return /\.(?:stl|obj|ply)$/i.test(fileName);
}

/** What the import used to assume, and so what the prompt preselects. */
export function historicalUnitlessReading(
  kind: UnitlessImportKind,
  documentUnits: UnitSystem
): UnitSystem {
  return kind === 'mesh' ? 'mm' : documentUnits;
}

/**
 * The unit a preference settles without asking, or null when it says ask.
 */
export function settledUnitlessReading(
  preference: UnitlessImportUnits,
  documentUnits: UnitSystem
): UnitSystem | null {
  if (preference === 'ask') return null;
  return preference === 'document' ? documentUnits : preference;
}

/** Axis-aligned size of flat `[x, y, z, …]` positions, per axis. */
export function meshExtent(vertices: ArrayLike<number>): number[] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertices[index + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return min.map((low, axis) => (Number.isFinite(low) ? max[axis]! - low : 0));
}

/** Width and height of sketch lines, arcs and circles. */
export function sketchObjectsExtent(
  objects: readonly SketchObjectData[]
): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const object of objects) {
    if (object.objectKind === 'line') {
      include(Number(object.x1), Number(object.y1));
      include(Number(object.x2), Number(object.y2));
    } else if (object.objectKind === 'circle' || object.objectKind === 'arc') {
      const cx = Number(object.centerX);
      const cy = Number(object.centerY);
      const r = Number(object.radius);
      if (object.objectKind === 'circle') {
        include(cx - r, cy - r);
        include(cx + r, cy + r);
        continue;
      }
      // An arc reaches its two ends plus every axis extreme it sweeps past.
      const start = Number(object.startAngleDeg);
      let end = Number(object.endAngleDeg);
      while (end < start) end += 360;
      const at = (deg: number) => {
        const radians = (deg * Math.PI) / 180;
        include(cx + r * Math.cos(radians), cy + r * Math.sin(radians));
      };
      at(start);
      at(end);
      for (
        let quadrant = Math.ceil(start / 90) * 90;
        quadrant < end;
        quadrant += 90
      ) {
        at(quadrant);
      }
    }
  }
  return Number.isFinite(minX) ? [maxX - minX, maxY - minY] : [0, 0];
}

/** A short number for a size readout: 3 significant figures, no exponent. */
function shortNumber(value: number): string {
  if (value === 0) return '0';
  const digits = Math.max(0, 2 - Math.floor(Math.log10(Math.abs(value))));
  return Number(value.toFixed(Math.min(digits, 6))).toString();
}

/**
 * The size the file's numbers make when read as `reading`, stated in the
 * project's units: "20 × 20 × 10 mm", "787 × 787 × 394 in".
 */
export function describeReadingSize(
  extent: readonly number[],
  reading: UnitSystem,
  documentUnits: UnitSystem
): string {
  const scale = UNIT_TO_MM[reading] / UNIT_TO_MM[documentUnits];
  return `${extent.map((value) => shortNumber(value * scale)).join(' × ')} ${UNIT_SUFFIX[documentUnits]}`;
}

/** Millimetre positions for numbers read in `reading` (the file's numbers). */
export function verticesReadAs<T extends ArrayLike<number>>(
  vertices: T,
  reading: UnitSystem
): number[] {
  const scale = UNIT_TO_MM[reading];
  return Array.from(vertices, (value) => value * scale);
}
