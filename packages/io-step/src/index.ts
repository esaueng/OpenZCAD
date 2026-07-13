import type { Solid, Vec3 } from '@openzcad/geometry';
import { validateSolid } from '@openzcad/geometry';
import { UNIT_TO_MM, type UnitSystem } from '@openzcad/shared';

/**
 * STEP (ISO 10303-21) writer.
 *
 * Emits a genuine AP214 (AUTOMOTIVE_DESIGN) part 21 file: a full product
 * structure plus one faceted MANIFOLD_SOLID_BREP per solid. Topology is
 * exact — vertices are shared VERTEX_POINTs and every undirected edge is a
 * single EDGE_CURVE referenced by exactly two ORIENTED_EDGEs with opposite
 * orientation — so importers (FreeCAD, SolidWorks, Fusion, OpenCascade)
 * read the shells as closed solids, not loose surfaces. All faces are
 * planar; curved geometry is tessellated by the kernel before export.
 *
 * Coordinates are written in millimetres (SI_UNIT .MILLI. .METRE.), scaled
 * from the document's unit system.
 */

export interface StepExportSolid {
  name: string;
  solid: Solid;
}

export interface StepExportOptions {
  /** Product / part name embedded in the file. */
  name: string;
  /** Document unit system; geometry is scaled to millimetres on write. */
  units: UnitSystem;
  /** Override the FILE_NAME timestamp (used by deterministic tests). */
  timestamp?: string;
}

export class StepExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepExportError';
  }
}

function formatReal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new StepExportError('Cannot write a non-finite coordinate to STEP.');
  }
  // Round to a fixed grid to avoid exponent notation and noise digits, then
  // ensure the token contains a decimal point as part 21 requires for REALs.
  let rounded = Math.round(value * 1e7) / 1e7;
  if (Object.is(rounded, -0)) {
    rounded = 0;
  }
  let text = rounded.toFixed(7).replace(/0+$/, '');
  if (text.endsWith('.')) {
    return text;
  }
  if (!text.includes('.')) {
    text += '.';
  }
  return text;
}

function stepString(value: string): string {
  // Part 21 strings are single-quoted; quotes escape by doubling. Strip
  // control characters and non-ASCII rather than emitting \X\ encodings.
  // eslint-disable-next-line no-control-regex -- removing control chars is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\uffff]/g, '').replace(/'/g, "''");
  return `'${cleaned}'`;
}

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

function newellNormal(points: Vec3Like[]): Vec3Like {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    x += (a.y - b.y) * (a.z + b.z);
    y += (a.z - b.z) * (a.x + b.x);
    z += (a.x - b.x) * (a.y + b.y);
  }
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) {
    throw new StepExportError('Encountered a degenerate face while writing STEP.');
  }
  return { x: x / length, y: y / length, z: z / length };
}

function normalizeOrthogonal(direction: Vec3Like, axis: Vec3Like): Vec3Like {
  const dot = direction.x * axis.x + direction.y * axis.y + direction.z * axis.z;
  const x = direction.x - dot * axis.x;
  const y = direction.y - dot * axis.y;
  const z = direction.z - dot * axis.z;
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) {
    // Fall back to any vector orthogonal to the axis.
    const fallback =
      Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    return normalizeOrthogonal(fallback, axis);
  }
  return { x: x / length, y: y / length, z: z / length };
}

class StepWriter {
  private lines: string[] = [];
  private nextId = 1;

  add(body: string): number {
    const id = this.nextId++;
    this.lines.push(`#${id}=${body};`);
    return id;
  }

  cartesianPoint(p: Vec3Like): number {
    return this.add(
      `CARTESIAN_POINT('',(${formatReal(p.x)},${formatReal(p.y)},${formatReal(p.z)}))`
    );
  }

  direction(d: Vec3Like): number {
    return this.add(
      `DIRECTION('',(${formatReal(d.x)},${formatReal(d.y)},${formatReal(d.z)}))`
    );
  }

  toString(): string {
    return this.lines.join('\n');
  }
}

interface SolidGeometryIds {
  brepId: number;
}

function writeSolidBrep(
  writer: StepWriter,
  name: string,
  solid: Solid,
  scale: number
): SolidGeometryIds {
  if (solid.faces.length < 4) {
    throw new StepExportError(`Solid "${name}" has too few faces to form a closed shell.`);
  }
  const points: Vec3[] = solid.vertices.map((p) => ({
    x: p.x * scale,
    y: p.y * scale,
    z: p.z * scale
  }));

  // Shared topology: one VERTEX_POINT per solid vertex...
  const vertexPointIds = points.map((p) => {
    const pointId = writer.cartesianPoint(p);
    return writer.add(`VERTEX_POINT('',#${pointId})`);
  });

  // ...and one EDGE_CURVE per undirected edge, oriented low->high index.
  const edgeCurveIds = new Map<string, number>();
  const edgeCurveFor = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    let id = edgeCurveIds.get(key);
    if (id !== undefined) {
      return id;
    }
    const start = points[lo]!;
    const end = points[hi]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-9) {
      throw new StepExportError(`Solid "${name}" contains a zero-length edge.`);
    }
    const originId = writer.cartesianPoint(start);
    const directionId = writer.direction({ x: dx / length, y: dy / length, z: dz / length });
    const vectorId = writer.add(`VECTOR('',#${directionId},1.)`);
    const lineId = writer.add(`LINE('',#${originId},#${vectorId})`);
    id = writer.add(
      `EDGE_CURVE('',#${vertexPointIds[lo]!},#${vertexPointIds[hi]!},#${lineId},.T.)`
    );
    edgeCurveIds.set(key, id);
    return id;
  };

  const faceIds: number[] = [];
  for (const face of solid.faces) {
    if (face.length < 3) {
      continue;
    }
    const facePoints = face.map((index) => points[index]!);
    const normal = newellNormal(facePoints);

    const orientedEdgeIds: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i]!;
      const b = face[(i + 1) % face.length]!;
      const curveId = edgeCurveFor(a, b);
      const sameSense = a < b ? '.T.' : '.F.';
      orientedEdgeIds.push(writer.add(`ORIENTED_EDGE('',*,*,#${curveId},${sameSense})`));
    }

    const loopId = writer.add(
      `EDGE_LOOP('',(${orientedEdgeIds.map((id) => `#${id}`).join(',')}))`
    );
    const boundId = writer.add(`FACE_OUTER_BOUND('',#${loopId},.T.)`);

    const origin = facePoints[0]!;
    const refDirection = normalizeOrthogonal(
      {
        x: facePoints[1]!.x - origin.x,
        y: facePoints[1]!.y - origin.y,
        z: facePoints[1]!.z - origin.z
      },
      normal
    );
    const originId = writer.cartesianPoint(origin);
    const axisId = writer.direction(normal);
    const refId = writer.direction(refDirection);
    const placementId = writer.add(`AXIS2_PLACEMENT_3D('',#${originId},#${axisId},#${refId})`);
    const planeId = writer.add(`PLANE('',#${placementId})`);
    faceIds.push(writer.add(`ADVANCED_FACE('',(#${boundId}),#${planeId},.T.)`));
  }

  const shellId = writer.add(
    `CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`
  );
  const brepId = writer.add(`MANIFOLD_SOLID_BREP(${stepString(name)},#${shellId})`);
  return { brepId };
}

export interface StepExportResult {
  text: string;
  /** Warnings that do not prevent export (e.g. shells that are not closed). */
  warnings: string[];
}

export function writeStepFile(
  solids: StepExportSolid[],
  options: StepExportOptions
): StepExportResult {
  if (solids.length === 0) {
    throw new StepExportError('Nothing to export: select at least one solid body.');
  }
  const warnings: string[] = [];
  for (const entry of solids) {
    const validation = validateSolid(entry.solid);
    if (!validation.closed) {
      warnings.push(
        `Body "${entry.name}" is not perfectly closed (${validation.openEdgeCount} open, ` +
          `${validation.nonManifoldEdgeCount} non-manifold edges); importers may need to sew it.`
      );
    }
  }

  const scale = UNIT_TO_MM[options.units];
  const timestamp = options.timestamp ?? new Date().toISOString();
  const partName = options.name.trim() || 'OpenZCAD Part';

  const writer = new StepWriter();

  // Application + product structure (AP214).
  const appContextId = writer.add(
    `APPLICATION_CONTEXT('core data for automotive mechanical design processes')`
  );
  writer.add(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2010,#${appContextId})`
  );
  const productContextId = writer.add(
    `PRODUCT_CONTEXT('',#${appContextId},'mechanical')`
  );
  const productId = writer.add(
    `PRODUCT(${stepString(partName)},${stepString(partName)},'',(#${productContextId}))`
  );
  const formationId = writer.add(`PRODUCT_DEFINITION_FORMATION('','',#${productId})`);
  const definitionContextId = writer.add(
    `PRODUCT_DEFINITION_CONTEXT('part definition',#${appContextId},'design')`
  );
  const productDefinitionId = writer.add(
    `PRODUCT_DEFINITION('design','',#${formationId},#${definitionContextId})`
  );
  const productShapeId = writer.add(
    `PRODUCT_DEFINITION_SHAPE('','',#${productDefinitionId})`
  );
  writer.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${productId}))`);

  // Geometric context: millimetres, radians, steradians, 1e-7 accuracy.
  const lengthUnitId = writer.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angleUnitId = writer.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solidAngleUnitId = writer.add(
    `(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`
  );
  const uncertaintyId = writer.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${lengthUnitId},'distance_accuracy_value','confusion accuracy')`
  );
  const contextId = writer.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertaintyId}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnitId},#${angleUnitId},#${solidAngleUnitId}))REPRESENTATION_CONTEXT('Context #1','3D Context'))`
  );

  // World placement + solids.
  const worldOriginId = writer.cartesianPoint({ x: 0, y: 0, z: 0 });
  const worldAxisId = writer.direction({ x: 0, y: 0, z: 1 });
  const worldRefId = writer.direction({ x: 1, y: 0, z: 0 });
  const worldPlacementId = writer.add(
    `AXIS2_PLACEMENT_3D('',#${worldOriginId},#${worldAxisId},#${worldRefId})`
  );

  const brepIds = solids.map((entry) =>
    writeSolidBrep(writer, entry.name, entry.solid, scale)
  );
  const itemRefs = [
    `#${worldPlacementId}`,
    ...brepIds.map(({ brepId }) => `#${brepId}`)
  ].join(',');
  const shapeRepresentationId = writer.add(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('',(${itemRefs}),#${contextId})`
  );
  writer.add(
    `SHAPE_DEFINITION_REPRESENTATION(#${productShapeId},#${shapeRepresentationId})`
  );

  const header = [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${stepString(`OpenZCAD model: ${partName}`)}),'2;1');`,
    `FILE_NAME(${stepString(`${partName}.step`)},${stepString(timestamp)},('OpenZCAD'),('OpenZCAD'),'OpenZCAD STEP writer','OpenZCAD','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;'
  ].join('\n');
  const footer = ['ENDSEC;', 'END-ISO-10303-21;', ''].join('\n');

  return {
    text: `${header}\n${writer.toString()}\n${footer}`,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Import-side helpers.
// ---------------------------------------------------------------------------

export interface ParsedStepMetadata {
  name: string;
  products: string[];
  colors: string[];
}

/**
 * Lightweight metadata scan of a STEP file (product names and colors).
 * Full B-Rep import requires a native kernel and remains follow-up work;
 * the UI is explicit about that.
 */
export function parseStepMetadata(fileName: string, text: string): ParsedStepMetadata {
  const products = Array.from(
    text.matchAll(/PRODUCT\('([^']+)'/g),
    (match) => match[1]
  ).filter((value): value is string => Boolean(value));
  const colors = Array.from(text.matchAll(/COLOUR_RGB\('([^']*)'/g), (match) =>
    match[1] ? match[1] : 'unnamed'
  );
  return { name: fileName, products, colors };
}
