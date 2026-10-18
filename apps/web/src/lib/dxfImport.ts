import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import { newCanonicalPlaneRef } from '@openzcad/geometry';
import {
  UNIT_TO_MM,
  type ProjectDocument,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';

/**
 * DXF sketch import (D04): an ASCII DXF's 2D geometry becomes one sketch's
 * lines, arcs and circles, scaled into the document's units. What a sketch
 * cannot hold is reported by entity type, never approximated: annotations and
 * blocks are dropped, curves the sketch has no object for are refused.
 *
 * Loaded only by the import that needs it, so none of it rides in the entry
 * chunk.
 */

/** A file with more entities than this is refused rather than half-read. */
export const MAX_DXF_SKETCH_OBJECTS = 2000;
/** Larger files are refused before parsing (about 2,000 curves is ~1 MB). */
export const MAX_DXF_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * Group-code/value pairs read before the file is refused. A dense 20 MB
 * drawing averages well over ten bytes a pair; four-byte filler pairs would
 * otherwise expand into millions of objects before any curve cap could fire.
 */
export const MAX_DXF_PAIRS = 2_000_000;
/** Entities of any type, kept or not, in the ENTITIES section. */
export const MAX_DXF_ENTITIES = 100_000;

/** Refuses a file by its size in bytes, before anything reads it. */
export function refuseOversizedDxf(bytes: number): void {
  if (bytes > MAX_DXF_IMPORT_BYTES) {
    throw new DxfImportError('This DXF is larger than 20 MB; split it first.');
  }
}

/** `$INSUNITS` codes the importer understands, in millimetres per unit. */
const INSUNITS_TO_MM: Readonly<Record<number, { mm: number; name: string }>> = {
  1: { mm: 25.4, name: 'inches' },
  2: { mm: 304.8, name: 'feet' },
  4: { mm: 1, name: 'millimetres' },
  5: { mm: 10, name: 'centimetres' },
  6: { mm: 1000, name: 'metres' },
  8: { mm: 0.0000254, name: 'microinches' },
  9: { mm: 0.0254, name: 'mils' },
  10: { mm: 914.4, name: 'yards' },
  13: { mm: 0.001, name: 'microns' },
  14: { mm: 100, name: 'decimetres' }
};

/** Annotation and organisation entities a sketch has no place for. */
const DROPPED = new Set([
  'TEXT',
  'MTEXT',
  'DIMENSION',
  'LEADER',
  'MLEADER',
  'HATCH',
  'INSERT',
  'POINT',
  'SOLID',
  'TRACE',
  'ATTDEF',
  'ATTRIB',
  'VIEWPORT',
  'IMAGE',
  'WIPEOUT',
  'TOLERANCE'
]);

export class DxfImportError extends Error {
  override name = 'DxfImportError';
}

interface Pair {
  code: number;
  value: string;
}

type DxfEntity = { type: string; groups: Pair[] };

export interface DxfSketchImport {
  objects: SketchObjectData[];
  /** How the file's units were read; null when it declared none. */
  sourceUnit: string | null;
  /** Annotation and block entities left out, by type. */
  dropped: Record<string, number>;
  /** Geometry the sketch cannot represent exactly, by type. */
  refused: Record<string, number>;
}

/** The file's group-code/value pairs; a malformed pair refuses the file. */
function readPairs(text: string): Pair[] {
  if (text.startsWith('AutoCAD Binary DXF')) {
    throw new DxfImportError(
      'This is a binary DXF; save it as ASCII DXF and import that.'
    );
  }
  // Lines are read one at a time, not split up front, so the pair cap
  // fires before the whole file has been turned into strings.
  let position = 0;
  let line = 0;
  const nextLine = (): string | null => {
    if (position > text.length) return null;
    let end = position;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end += 1;
    }
    const value = text.slice(position, end);
    position = text[end] === '\r' && text[end + 1] === '\n' ? end + 2 : end + 1;
    line += 1;
    return value;
  };
  const pairs: Pair[] = [];
  for (;;) {
    const codeLine = nextLine();
    if (codeLine === null) break;
    const valueLine = nextLine();
    const codeText = codeLine.trim();
    if (valueLine === null) {
      if (codeText === '') break;
      throw new DxfImportError(
        `This DXF is malformed: line ${line} has no value after it.`
      );
    }
    const code = Number(codeText);
    if (!/^-?\d+$/.test(codeText) || !Number.isInteger(code)) {
      throw new DxfImportError(
        `This DXF is malformed: line ${line - 1} should be a group code.`
      );
    }
    if (pairs.length >= MAX_DXF_PAIRS) {
      throw new DxfImportError(
        'This DXF has too many entries to import; split it first.'
      );
    }
    pairs.push({ code, value: valueLine.trim() });
  }
  return pairs;
}

/**
 * A DXF real or integer, or NaN. Stricter than `Number`, which reads a blank
 * value as 0 and would silently move a coordinate to the origin.
 */
function dxfNumber(text: string): number {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())
    ? Number(text)
    : Number.NaN;
}

/** The section named `name`, as the pairs between its header and ENDSEC. */
function section(pairs: Pair[], name: string): Pair[] | null {
  for (let index = 0; index + 1 < pairs.length; index += 1) {
    if (
      pairs[index]!.code === 0 &&
      pairs[index]!.value === 'SECTION' &&
      pairs[index + 1]!.code === 2 &&
      pairs[index + 1]!.value === name
    ) {
      const end = pairs.findIndex(
        (pair, at) => at > index && pair.code === 0 && pair.value === 'ENDSEC'
      );
      if (end < 0) {
        throw new DxfImportError(
          `This DXF is malformed: its ${name} section never ends.`
        );
      }
      return pairs.slice(index + 2, end);
    }
  }
  return null;
}

function entitiesOf(pairs: Pair[]): DxfEntity[] {
  const entities: DxfEntity[] = [];
  for (const pair of pairs) {
    if (pair.code === 0) {
      if (entities.length >= MAX_DXF_ENTITIES) {
        throw new DxfImportError(
          `This DXF has more than ${MAX_DXF_ENTITIES} entities; split it first.`
        );
      }
      entities.push({ type: pair.value, groups: [] });
    } else entities.at(-1)?.groups.push(pair);
  }
  return entities;
}

function insUnits(pairs: Pair[]): number | null {
  const header = section(pairs, 'HEADER');
  if (!header) return null;
  const at = header.findIndex(
    (pair) => pair.code === 9 && pair.value === '$INSUNITS'
  );
  if (at < 0) return null;
  // Present but damaged is not the same as absent: reading it as unitless
  // could scale the whole drawing by the wrong factor.
  const value = header[at + 1];
  const code = value && value.code === 70 ? dxfNumber(value.value) : NaN;
  if (!Number.isInteger(code)) {
    throw new DxfImportError(
      'This DXF is malformed: its $INSUNITS declaration has no usable value.'
    );
  }
  return code;
}

/** A radius: finite and strictly positive, or the file is malformed. */
function radius(entity: DxfEntity): number {
  const value = number(entity, 40);
  if (!(value > 0)) {
    throw new DxfImportError(
      `This DXF is malformed: a ${entity.type} has a radius of ${value}.`
    );
  }
  return value;
}

function number(entity: DxfEntity, code: number, fallback?: number): number {
  const found = entity.groups.find((pair) => pair.code === code);
  const value = found ? dxfNumber(found.value) : fallback;
  if (value === undefined || !Number.isFinite(value)) {
    throw new DxfImportError(
      `This DXF is malformed: a ${entity.type} has no usable group ${code}.`
    );
  }
  return value;
}

/**
 * Z coordinates and elevations: LINE's 30/31, CIRCLE/ARC/POLYLINE/VERTEX 30,
 * LWPOLYLINE 38. Anything off z = 0 would be flattened onto Top, so it is
 * refused instead.
 */
const Z_CODES = new Set([30, 31, 38]);

function onZeroElevation(entity: DxfEntity): boolean {
  return entity.groups.every(
    (pair) => !Z_CODES.has(pair.code) || dxfNumber(pair.value) === 0
  );
}

/**
 * True when the entity lies in the XY plane itself: no Z coordinate or
 * elevation off zero, no thickness (39) extending it out of the plane, and
 * an extrusion direction that is exactly +Z. No tolerance on the tilt: a
 * transverse component is multiplied by the coordinates, so even 1e-10 puts
 * a far point visibly off Top.
 */
function inXyPlane(entity: DxfEntity): boolean {
  if (!onZeroElevation(entity)) return false;
  const thickness = entity.groups.find((pair) => pair.code === 39);
  if (thickness && dxfNumber(thickness.value) !== 0) return false;
  const z = entity.groups.find((pair) => pair.code === 230);
  const x = entity.groups.find((pair) => pair.code === 210);
  const y = entity.groups.find((pair) => pair.code === 220);
  if (!z && !x && !y) return true;
  return (
    dxfNumber(x?.value ?? '0') === 0 &&
    dxfNumber(y?.value ?? '0') === 0 &&
    dxfNumber(z?.value ?? '1') > 0
  );
}

/**
 * Arc angles with end − start in (0, 360], the sketch's CCW convention.
 * `distinctEnds` marks an arc through two different points, which can never
 * be a whole turn: a sweep that rounds to 360° has lost the gap between them.
 */
function ccwArc(
  centerX: number,
  centerY: number,
  radius: number,
  startDeg: number,
  endDeg: number,
  distinctEnds = false
): SketchObjectData {
  // Angles keep the file's full precision: on a large radius even a 1e-9°
  // step moves an endpoint off the geometry it should meet.
  const turn = (degrees: number) => {
    // Add a turn only to a negative angle: (a + 360) % 360 would cost a
    // small positive angle most of its digits.
    const angle = degrees % 360;
    if (angle >= 0) return angle;
    const wrapped = angle + 360;
    return wrapped === 360 ? 0 : wrapped;
  };
  const start = turn(startDeg);
  let end = turn(endDeg);
  // Coincident ends are a zero sweep, never a whole turn: DXF draws a full
  // circle as a CIRCLE, and an ARC from 45° to 45° has no extent.
  if (end === start || end === start + 360 || end + 360 === start) {
    throw new DxfImportError(
      distinctEnds
        ? 'This DXF has a polyline bulge too extreme to convert exactly.'
        : 'This DXF has an arc too short to represent: its sweep rounds to zero.'
    );
  }
  if (end < start) end += 360;
  if (!(end > start)) {
    throw new DxfImportError(
      'This DXF has an arc too short to represent: its sweep rounds to zero.'
    );
  }
  if (distinctEnds && end - start >= 360) {
    throw new DxfImportError(
      'This DXF has a polyline bulge too extreme to convert exactly.'
    );
  }
  return {
    objectKind: 'arc',
    centerX,
    centerY,
    radius,
    startAngleDeg: start,
    endAngleDeg: end
  };
}

/**
 * The largest coordinate an import keeps. Far past any real drawing, and far
 * enough under the double range that spans, squares and extents built from
 * these coordinates downstream stay finite.
 */
const MAX_COORDINATE = 1e100;

const tooLarge = () =>
  new DxfImportError(
    'This DXF has coordinates too large to convert into the document units.'
  );

/** One polyline segment, a straight line or the arc its bulge describes. */
function segment(
  from: { x: number; y: number },
  to: { x: number; y: number },
  bulge: number
): SketchObjectData | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  if (!Number.isFinite(chord)) throw tooLarge();
  // Only a repeated vertex with no bulge is harmlessly skipped; a bulge on
  // it, or a chord too short to build, has a meaning the sketch would lose.
  if (chord === 0 && bulge === 0) return null;
  if (chord < 1e-12) {
    throw new DxfImportError(
      'This DXF has a segment too short to represent exactly.'
    );
  }
  // Only an exact zero is straight: a tiny bulge across a long chord still
  // bows by a real distance, and one whose sweep is too small to store
  // refuses in ccwArc rather than flattening.
  if (bulge === 0) {
    return { objectKind: 'line', x1: from.x, y1: from.y, x2: to.x, y2: to.y };
  }
  // bulge = tan(θ/4), positive counter-clockwise from `from` to `to`. The
  // radius and apothem come straight from the bulge, not through θ: near a
  // full turn atan saturates to π/2 and sin(θ/2) to a wrong value.
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  // Distance from the chord midpoint to the centre, signed toward the left
  // of from→to for a CCW (positive) bulge.
  const apothem = (chord * (1 - bulge * bulge)) / (4 * bulge);
  if (!Number.isFinite(radius) || !Number.isFinite(apothem)) {
    throw new DxfImportError(
      'This DXF has a polyline bulge too extreme to convert exactly.'
    );
  }
  const centerX = midX - (dy / chord) * apothem;
  const centerY = midY + (dx / chord) * apothem;
  const angle = (point: { x: number; y: number }) =>
    (Math.atan2(point.y - centerY, point.x - centerX) * 180) / Math.PI;
  return bulge > 0
    ? ccwArc(centerX, centerY, radius, angle(from), angle(to), true)
    : ccwArc(centerX, centerY, radius, angle(to), angle(from), true);
}

interface Vertex {
  x: number;
  y: number;
  bulge: number;
}

/** Emits a polyline's segments one by one, so a cap can stop it early. */
function polylineObjects(
  vertices: Vertex[],
  closed: boolean,
  add: (object: SketchObjectData) => void
): void {
  const count = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < count; index += 1) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % vertices.length]!;
    const piece = segment(from, to, from.bulge);
    if (piece) add(piece);
  }
}

const incompleteVertices = () =>
  new DxfImportError(
    'This DXF is malformed: a LWPOLYLINE has an incomplete or unusable vertex list.'
  );

/** Wide polylines (40/41 start/end, 43 constant width) draw a band, not the centreline. */
function hasWidth(entity: DxfEntity): boolean {
  return entity.groups.some(
    (pair) =>
      (pair.code === 40 || pair.code === 41 || pair.code === 43) &&
      dxfNumber(pair.value) !== 0
  );
}

/** LWPOLYLINE vertices: each 10/20 pair, with any 42 bulge that follows. */
function lwVertices(entity: DxfEntity): Vertex[] {
  const vertices: Vertex[] = [];
  let pendingX: number | null = null;
  // Each 42 belongs to the vertex just completed, at most once.
  let bulged = false;
  for (const pair of entity.groups) {
    if (pair.code === 10) {
      // An X before the last one found its Y would re-pair the stream.
      if (pendingX !== null) throw incompleteVertices();
      pendingX = dxfNumber(pair.value);
    } else if (pair.code === 20) {
      if (pendingX === null) throw incompleteVertices();
      vertices.push({ x: pendingX, y: dxfNumber(pair.value), bulge: 0 });
      pendingX = null;
      bulged = false;
    } else if (pair.code === 42) {
      // A bulge before any vertex, inside a half-read one, or a second one
      // for the same vertex has no single meaning.
      if (vertices.length === 0 || pendingX !== null || bulged) {
        throw incompleteVertices();
      }
      vertices.at(-1)!.bulge = dxfNumber(pair.value);
      bulged = true;
    }
  }
  const declared = entity.groups.find((pair) => pair.code === 90);
  if (
    pendingX !== null ||
    vertices.some((v) => !Number.isFinite(v.x + v.y + v.bulge)) ||
    (declared !== undefined && dxfNumber(declared.value) !== vertices.length)
  ) {
    // A truncated vertex list would import as a different outline.
    throw incompleteVertices();
  }
  return vertices;
}

/**
 * Reads an ASCII DXF and lowers its 2D geometry to sketch objects in the
 * document's units. `unitless` is how a file that declares no units is read
 * (its drawing units taken as these).
 */
export function importDxfSketch(
  text: string,
  documentUnits: UnitSystem,
  unitless: UnitSystem = documentUnits
): DxfSketchImport {
  // The caller refuses by byte size first; this guards direct callers.
  refuseOversizedDxf(text.length);
  const pairs = readPairs(text);
  const entitiesSection = section(pairs, 'ENTITIES');
  if (!entitiesSection) {
    throw new DxfImportError('This DXF has no ENTITIES section to import.');
  }
  const unitCode = insUnits(pairs);
  const known = unitCode !== null ? INSUNITS_TO_MM[unitCode] : undefined;
  if (unitCode !== null && unitCode !== 0 && !known) {
    throw new DxfImportError(
      `This DXF uses a unit OpenZCAD cannot read ($INSUNITS ${unitCode}).`
    );
  }
  const sourceMm = known ? known.mm : UNIT_TO_MM[unitless];
  const documentMm = UNIT_TO_MM[documentUnits];
  // `|| 0` folds -0 to 0, so stored coordinates never carry a signed zero.
  const s = (value: number) => {
    // No rounding of any kind: every value is converted the same way, so
    // an arc endpoint that met a line in the file still meets it. Multiply
    // by the source unit and divide by the document one, rather than by
    // their ratio, so 25.4 mm lands on exactly 1 inch.
    const scaled = (value * sourceMm) / documentMm || 0;
    if (!(Math.abs(scaled) <= MAX_COORDINATE)) throw tooLarge();
    return scaled;
  };

  const objects: SketchObjectData[] = [];
  const dropped: Record<string, number> = {};
  const refused: Record<string, number> = {};
  const count = (into: Record<string, number>, type: string) => {
    into[type] = (into[type] ?? 0) + 1;
  };

  // Checked per curve, so one huge polyline stops at the cap instead of
  // building every segment first.
  const add = (object: SketchObjectData) => {
    if (objects.length >= MAX_DXF_SKETCH_OBJECTS) {
      throw new DxfImportError(
        `This DXF has more than ${MAX_DXF_SKETCH_OBJECTS} curves; a sketch takes at most that many.`
      );
    }
    objects.push(object);
  };

  const entities = entitiesOf(entitiesSection);
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index]!;
    if (entity.type === 'SEQEND' || entity.type === 'VERTEX') continue;
    if (DROPPED.has(entity.type)) {
      count(dropped, entity.type);
      continue;
    }
    if (!inXyPlane(entity)) {
      count(refused, `${entity.type} off the XY plane`);
      continue;
    }
    switch (entity.type) {
      case 'LINE': {
        const line = segment(
          { x: number(entity, 10), y: number(entity, 20) },
          { x: number(entity, 11), y: number(entity, 21) },
          0
        );
        // A polyline's repeated vertex is harmless to skip; a LINE that is
        // nothing but a point is a drawing the sketch cannot reproduce.
        if (!line) {
          throw new DxfImportError(
            'This DXF is malformed: it has a LINE whose endpoints coincide.'
          );
        }
        add(line);
        break;
      }
      case 'CIRCLE':
        add({
          objectKind: 'circle',
          centerX: number(entity, 10),
          centerY: number(entity, 20),
          radius: radius(entity)
        });
        break;
      case 'ARC':
        add(
          ccwArc(
            number(entity, 10),
            number(entity, 20),
            radius(entity),
            number(entity, 50),
            number(entity, 51)
          )
        );
        break;
      case 'LWPOLYLINE':
        if (hasWidth(entity)) {
          count(refused, 'LWPOLYLINE with width');
          break;
        }
        polylineObjects(
          lwVertices(entity),
          (number(entity, 70, 0) & 1) === 1,
          add
        );
        break;
      case 'POLYLINE': {
        const flags = number(entity, 70, 0);
        const vertexEntities: DxfEntity[] = [];
        while (entities[index + 1]?.type === 'VERTEX') {
          index += 1;
          vertexEntities.push(entities[index]!);
        }
        // 3D polylines (8) and meshes (16, 64) are not 2D sketch geometry,
        // and neither are their records when the parent flag is missing:
        // VERTEX 32 is a 3D vertex, 64 a mesh vertex, 128 a polyface one.
        if (
          (flags & (8 | 16 | 64)) !== 0 ||
          vertexEntities.some(
            (vertex) => (number(vertex, 70, 0) & (32 | 64 | 128)) !== 0
          )
        ) {
          count(refused, 'POLYLINE (3D or mesh)');
          break;
        }
        // Curve- (2) and spline-fitted (4) polylines describe a smooth
        // curve their vertices only approximate; joining them with straight
        // segments would change the outline. Also inspect the vertices when
        // the parent flags are missing: 1 is curve-fit generated, 8 is
        // spline-fit generated, and 16 is a spline frame control point.
        if (
          (flags & (2 | 4)) !== 0 ||
          vertexEntities.some(
            (vertex) => (number(vertex, 70, 0) & (1 | 8 | 16)) !== 0
          )
        ) {
          count(refused, 'POLYLINE (curve-fit or spline-fit)');
          break;
        }
        if (hasWidth(entity) || vertexEntities.some(hasWidth)) {
          count(refused, 'POLYLINE with width');
          break;
        }
        if (!vertexEntities.every(onZeroElevation)) {
          count(refused, 'POLYLINE off the XY plane');
          break;
        }
        const vertices: Vertex[] = vertexEntities.map((vertex) => ({
          x: number(vertex, 10),
          y: number(vertex, 20),
          bulge: number(vertex, 42, 0)
        }));
        polylineObjects(vertices, (flags & 1) === 1, add);
        break;
      }
      default:
        // ELLIPSE, SPLINE, 3DFACE, REGION, … have no exact sketch object.
        count(refused, entity.type);
    }
  }

  const scaled = objects.map(scaleObject(s));
  return {
    objects: scaled,
    sourceUnit: known ? known.name : null,
    dropped,
    refused
  };
}

function scaleObject(s: (value: number) => number) {
  const degenerate = () =>
    new DxfImportError(
      'This DXF has geometry too small to represent in the document units.'
    );
  return (object: SketchObjectData): SketchObjectData => {
    switch (object.objectKind) {
      case 'line': {
        const line = {
          ...object,
          x1: s(Number(object.x1)),
          y1: s(Number(object.y1)),
          x2: s(Number(object.x2)),
          y2: s(Number(object.y2))
        };
        if (line.x1 === line.x2 && line.y1 === line.y2) throw degenerate();
        return line;
      }
      case 'circle':
      case 'arc': {
        const curve = {
          ...object,
          centerX: s(Number(object.centerX)),
          centerY: s(Number(object.centerY)),
          radius: s(Number(object.radius))
        };
        if (!(curve.radius > 0)) throw degenerate();
        return curve;
      }
      default:
        return object;
    }
  };
}

/** "3 TEXT, 1 HATCH" for a status line; empty when there is nothing. */
export function describeDxfCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');
}

/**
 * What importing `fileName` commits: one undoable sketch on Top (XY) named
 * after the file, and the status line that says what was read, converted and
 * left out. Throws a {@link DxfImportError} when nothing in the file is
 * sketch geometry.
 */
export function dxfSketchImportPlan(
  document: ProjectDocument,
  fileName: string,
  text: string,
  nameFeature: (name: string) => string
): { command: AnyCommand; status: string } {
  const result = importDxfSketch(text, document.units);
  const left = [
    describeDxfCounts(result.dropped),
    describeDxfCounts(result.refused)
  ]
    .filter(Boolean)
    .join(', ');
  if (result.objects.length === 0) {
    throw new DxfImportError(
      `${fileName} has no lines, arcs, circles or polylines to sketch${left ? ` (only ${left})` : ''}.`
    );
  }
  const name = nameFeature(fileName.replace(/\.dxf$/i, '') || 'DXF sketch');
  const units = result.sourceUnit
    ? result.sourceUnit === unitName(document.units)
      ? ''
      : `, converted from ${result.sourceUnit}`
    : `; it declares no units, so they were read as ${unitName(document.units)}`;
  const parts = [
    result.dropped && Object.keys(result.dropped).length
      ? `left out ${describeDxfCounts(result.dropped)}`
      : '',
    Object.keys(result.refused).length
      ? `could not sketch ${describeDxfCounts(result.refused)}`
      : ''
  ].filter(Boolean);
  const curves = result.objects.length;
  return {
    command: commandFactories.addSketch({
      name,
      planeRef: newCanonicalPlaneRef('XY', 0),
      objects: result.objects
    }),
    status: `Imported ${curves} ${curves === 1 ? 'curve' : 'curves'} from ${fileName} as sketch "${name}"${units}${parts.length ? ` · ${parts.join('; ')}` : ''}.`
  };
}

function unitName(units: UnitSystem): string {
  return units === 'inch'
    ? 'inches'
    : units === 'mm'
      ? 'millimetres'
      : units === 'cm'
        ? 'centimetres'
        : 'metres';
}
