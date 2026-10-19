import { UNIT_TO_MM, type UnitSystem } from '@openzcad/shared';

/**
 * Export units and mesh tolerances.
 *
 * Every writer the kernel ships takes model numbers as they are and, where
 * the format can say so, declares millimetres. Writing another unit is
 * therefore two steps: scale the solids into that unit before the writer
 * sees them, then make the file's own unit declaration say the same thing.
 * The declaration edits below are narrow on purpose — each one matches the
 * writer's single, known unit entity or attribute and refuses anything else,
 * so a changed writer fails an export loudly instead of shipping a file whose
 * numbers and header disagree by a factor of 25.4.
 */

/** Where the format can carry a unit: the one to write. Millimetres if unset. */
export interface ExportUnitOptions {
  units?: UnitSystem;
}

/** A mesh export's unit plus its optional angular tolerance in radians. */
export interface MeshExportTolerances extends ExportUnitOptions {
  /**
   * Largest angle, in radians, a facet may turn from its neighbour along a
   * curved face. Unset (or the kernel default) keeps the writers' own path.
   */
  angularTolerance?: number;
}

/** The kernel's own angular tolerance when none is given: 0.35 rad (~20°). */
export const DEFAULT_MESH_ANGULAR_TOLERANCE = 0.35;

/** Numbers in the export unit per number in the document unit. */
export function exportLengthScale(
  documentUnits: UnitSystem,
  exportUnits: UnitSystem
): number {
  return UNIT_TO_MM[documentUnits] / UNIT_TO_MM[exportUnits];
}

/**
 * The angular tolerance a mesh export should hand the kernel, or null for
 * the writers' own default path. Null keeps the default export byte-for-byte
 * what it was before the angle became a choice.
 */
export function explicitAngularTolerance(
  angularTolerance: number | undefined
): number | null {
  if (angularTolerance === undefined) return null;
  if (!Number.isFinite(angularTolerance) || angularTolerance <= 0) {
    throw new Error('Mesh export angle must be a positive number of radians.');
  }
  if (angularTolerance > Math.PI / 2) {
    throw new Error('Mesh export angle must be at most 90°.');
  }
  return Math.abs(angularTolerance - DEFAULT_MESH_ANGULAR_TOLERANCE) < 1e-12
    ? null
    : angularTolerance;
}

/** The STEP writer's one length unit, as it writes it. */
const STEP_MILLIMETRE_UNIT =
  /^(#\d+)\s*=\s*\(\s*LENGTH_UNIT\(\s*\)\s*NAMED_UNIT\(\s*\*\s*\)\s*SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)\s*\)\s*;[^\S\r\n]*$/gm;

/**
 * Rewrites the STEP writer's millimetre length unit to `units`. The caller
 * has already scaled the geometry; this makes the header agree. Inches are a
 * `CONVERSION_BASED_UNIT` of 25.4 mm, the form every AP203/AP214 reader
 * (the paired importer included) resolves.
 */
export function declareStepLengthUnit(step: string, units: UnitSystem): string {
  if (units === 'mm') return step;
  const matches = [...step.matchAll(STEP_MILLIMETRE_UNIT)];
  if (matches.length !== 1) {
    throw new Error(
      `The STEP writer's length unit could not be restated in ${units}; export in millimetres instead.`
    );
  }
  const [match] = matches;
  const id = match![1]!;
  if (units === 'cm' || units === 'm') {
    const prefix = units === 'cm' ? '.CENTI.' : '$';
    return step.replace(
      match![0],
      `${id} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(${prefix},.METRE.) );`
    );
  }
  const next =
    Math.max(...[...step.matchAll(/^#(\d+)\s*=/gm)].map((m) => Number(m[1]))) +
    1;
  const measure = `#${next}`;
  const millimetre = `#${next + 1}`;
  const exponents = `#${next + 2}`;
  return step.replace(
    match![0],
    [
      `${id} = ( CONVERSION_BASED_UNIT('INCH',${measure}) LENGTH_UNIT() NAMED_UNIT(${exponents}) );`,
      `${measure} = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${millimetre});`,
      `${millimetre} = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );`,
      `${exponents} = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);`
    ].join('\n')
  );
}

/** The 3MF core specification's names for the units an export can write. */
export const THREE_MF_UNIT_NAMES: Record<UnitSystem, string> = {
  mm: 'millimeter',
  cm: 'centimeter',
  m: 'meter',
  inch: 'inch'
};

/**
 * Sets the `<model unit="…">` attribute of a 3MF model part. The writer
 * declares millimetres (or omits the attribute, which means the same).
 */
export function declareThreeMfUnit(model: string, units: UnitSystem): string {
  const open = /<model\b[^>]*>/.exec(model);
  if (!open) {
    throw new Error('Mesh export produced a 3MF model part without <model>.');
  }
  const tag = open[0];
  const unit = /\bunit="([^"]*)"/.exec(tag);
  if (unit && unit[1] !== 'millimeter') {
    throw new Error(
      `The 3MF writer declared "${unit[1]}", not millimeters; the export unit cannot be applied.`
    );
  }
  const name = THREE_MF_UNIT_NAMES[units];
  const rewritten = unit
    ? tag.replace(unit[0], `unit="${name}"`)
    : tag.replace(/^<model\b/, `<model unit="${name}"`);
  return model.replace(tag, rewritten);
}

/** The most triangles a deviation check samples before striding. */
export const DEVIATION_SAMPLE_TRIANGLES = 40_000;

/**
 * Largest distance from the tessellation to the exact faces it stands for.
 * Every triangle is measured at its corners: the stored (float32) vertex
 * positions, which on a tilted or distant plane can sit off the exact
 * carrier by more than any chord tolerance. A triangle on a curved face is
 * also measured at its centroid and edge midpoints, where a flat facet strays
 * furthest from a convex or concave carrier; on a plane those interior points
 * are interpolations of the corners and add nothing. Shared corners are
 * measured once per face. Above {@link DEVIATION_SAMPLE_TRIANGLES} triangles
 * the check strides, and says so.
 */
export function measureMeshDeviation(input: {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  faceOffsets: ArrayLike<number>;
  faces: ArrayLike<number>;
  isPlanar: (face: number) => boolean;
  distance: (x: number, y: number, z: number, face: number) => number;
}): {
  maxDeviation: number;
  sampledTriangles: number;
  totalTriangles: number;
} {
  const { positions, indices, faceOffsets, faces } = input;
  const groups: { face: number; start: number; end: number }[] = [];
  let totalTriangles = 0;
  for (let group = 0; group + 1 < faceOffsets.length; group += 1) {
    const face = faces[group];
    if (face === undefined) continue;
    const start = faceOffsets[group]!;
    const end = faceOffsets[group + 1]!;
    groups.push({ face, start, end });
    totalTriangles += (end - start) / 3;
  }
  const stride = Math.max(
    1,
    Math.ceil(totalTriangles / DEVIATION_SAMPLE_TRIANGLES)
  );
  let maxDeviation = 0;
  let sampledTriangles = 0;
  let seen = 0;
  const vertexAt = (corner: number) => {
    const vertex = indices[corner]!;
    return [
      positions[vertex * 3]!,
      positions[vertex * 3 + 1]!,
      positions[vertex * 3 + 2]!
    ] as const;
  };
  const measure = (x: number, y: number, z: number, face: number) => {
    maxDeviation = Math.max(maxDeviation, input.distance(x, y, z, face));
  };
  for (const { face, start, end } of groups) {
    const planar = input.isPlanar(face);
    const measuredCorners = new Set<number>();
    for (let t = start; t + 2 < end; t += 3) {
      if (seen++ % stride !== 0) continue;
      sampledTriangles += 1;
      for (let corner = t; corner < t + 3; corner += 1) {
        const vertex = indices[corner]!;
        if (measuredCorners.has(vertex)) continue;
        measuredCorners.add(vertex);
        const [x, y, z] = vertexAt(corner);
        measure(x, y, z, face);
      }
      if (planar) continue;
      const a = vertexAt(t);
      const b = vertexAt(t + 1);
      const c = vertexAt(t + 2);
      measure(
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
        face
      );
      measure((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, face);
      measure((b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2, face);
      measure((c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2, face);
    }
  }
  return { maxDeviation, sampledTriangles, totalTriangles };
}
