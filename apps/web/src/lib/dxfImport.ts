import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  computeSketchProfileAnalysis,
  newCanonicalPlaneRef
} from '@openzcad/geometry';
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
  let read = 0;
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
    read += 1;
    if (read > MAX_DXF_PAIRS) {
      throw new DxfImportError(
        'This DXF has too many entries to import; split it first.'
      );
    }
    // 999 is a comment: counted toward the cap, never part of the structure
    // (it may sit between $INSUNITS and its value, or SECTION and its name).
    if (code === 999) continue;
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

/**
 * The file's sections by name, read in one forward pass that also checks the
 * outer shape: only `0 SECTION` / `2 <name>` … `0 ENDSEC` blocks, then `0 EOF`
 * as the last record (or the end of the text). Anything else refuses the
 * file: a record between sections is what an early ENDSEC leaves behind, a
 * section that meets another SECTION or EOF first was cut short, a header
 * with no name cannot be found again, a second section of one name (a
 * concatenated file) has no single reading, and data after EOF would be
 * ignored.
 */
function sectionsOf(pairs: Pair[]): Map<string, Pair[]> {
  const sections = new Map<string, Pair[]>();
  let index = 0;
  while (index < pairs.length) {
    const pair = pairs[index]!;
    if (pair.code === 0 && pair.value === 'EOF') {
      if (index !== pairs.length - 1) {
        throw new DxfImportError(
          'This DXF is malformed: it has records after EOF.'
        );
      }
      break;
    }
    if (!(pair.code === 0 && pair.value === 'SECTION')) {
      throw new DxfImportError(
        'This DXF is malformed: it has records outside any section.'
      );
    }
    const header = pairs[index + 1];
    if (!header || header.code !== 2) {
      throw new DxfImportError(
        'This DXF is malformed: a SECTION has no name after it.'
      );
    }
    const name = header.value;
    let end = index + 2;
    while (
      end < pairs.length &&
      !(
        pairs[end]!.code === 0 &&
        (pairs[end]!.value === 'ENDSEC' ||
          pairs[end]!.value === 'SECTION' ||
          pairs[end]!.value === 'EOF')
      )
    ) {
      end += 1;
    }
    if (end >= pairs.length || pairs[end]!.value !== 'ENDSEC') {
      throw new DxfImportError(
        `This DXF is malformed: its ${name} section never ends.`
      );
    }
    if (sections.has(name)) {
      throw new DxfImportError(
        `This DXF is malformed: it has two ${name} sections.`
      );
    }
    sections.set(name, pairs.slice(index + 2, end));
    index = end + 1;
  }
  return sections;
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
    } else {
      // Every record opens with group 0; groups before the first one are
      // what is left of an entity whose marker was lost.
      const current = entities.at(-1);
      if (!current) {
        throw new DxfImportError(
          'This DXF is malformed: its ENTITIES section has data before the first entity.'
        );
      }
      current.groups.push(pair);
    }
  }
  return entities;
}

function insUnits(header: Pair[] | undefined): number | null {
  if (!header) return null;
  const isInsUnits = (pair: Pair) =>
    pair.code === 9 && pair.value === '$INSUNITS';
  const at = header.findIndex(isInsUnits);
  if (at < 0) return null;
  // A second declaration could name a different unit; whichever came first
  // would scale the drawing by a guess.
  if (header.findIndex((pair, index) => index > at && isInsUnits(pair)) >= 0) {
    throw new DxfImportError(
      'This DXF is malformed: it declares $INSUNITS twice.'
    );
  }
  // Present but damaged is not the same as absent: reading it as unitless
  // could scale the whole drawing by the wrong factor. The declaration is
  // exactly one group-70 value before the next header variable; two values
  // (or anything else) have no single reading.
  const next = header.findIndex((pair, index) => index > at && pair.code === 9);
  const values = header.slice(at + 1, next < 0 ? header.length : next);
  const value = values.length === 1 ? values[0] : undefined;
  const code = value && value.code === 70 ? dxfNumber(value.value) : NaN;
  if (!Number.isInteger(code)) {
    throw new DxfImportError(
      'This DXF is malformed: its $INSUNITS declaration has no usable value.'
    );
  }
  return code;
}

/**
 * Layers whose geometry is not shown: frozen (LAYER 70 bit 1) or off (a
 * negative 62 colour), read from the TABLES section's LAYER table.
 */
function hiddenLayers(tables: Pair[] | undefined): Set<string> {
  const hidden = new Set<string>();
  if (!tables) return hidden;
  let inLayers = false;
  let layer: DxfEntity | null = null;
  const settle = () => {
    if (!layer) return;
    const name = singleGroup(layer, 2)?.value;
    const color = singleGroup(layer, 62);
    if (
      name !== undefined &&
      ((integerFlags(layer, 70) & 1) !== 0 ||
        (color !== undefined && dxfNumber(color.value) < 0))
    ) {
      hidden.add(name.toUpperCase());
    }
    layer = null;
  };
  for (let index = 0; index < tables.length; index += 1) {
    const pair = tables[index]!;
    if (pair.code === 0) {
      settle();
      if (pair.value === 'TABLE') {
        const next = tables[index + 1];
        inLayers = next?.code === 2 && next.value === 'LAYER';
      } else if (pair.value === 'ENDTAB') {
        inLayers = false;
      } else if (inLayers && pair.value === 'LAYER') {
        layer = { type: 'LAYER', groups: [] };
      }
    } else if (layer) {
      layer.groups.push(pair);
    }
  }
  settle();
  return hidden;
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

/**
 * The one occurrence of a scalar group, or undefined when it is absent. A
 * repeated scalar refuses the entity rather than letting the first copy win:
 * two group-10s on a LINE, or two bulges on a VERTEX, have no single meaning.
 */
function singleGroup(entity: DxfEntity, code: number): Pair | undefined {
  let found: Pair | undefined;
  for (const pair of entity.groups) {
    if (pair.code !== code) continue;
    if (found) {
      throw new DxfImportError(
        `This DXF is malformed: a ${entity.type} repeats group ${code}.`
      );
    }
    found = pair;
  }
  return found;
}

/**
 * An integer group (flags, space markers) as a 16-bit integer, 0 when absent.
 * A fractional or out-of-range value refuses the file: bit masks would
 * silently truncate it into a different flag set.
 */
function integerFlags(entity: DxfEntity, code: number): number {
  const pair = singleGroup(entity, code);
  if (!pair) return 0;
  const value = dxfNumber(pair.value);
  if (!Number.isInteger(value) || value < -32768 || value > 32767) {
    throw new DxfImportError(
      `This DXF is malformed: a ${entity.type} has an unusable group ${code} value.`
    );
  }
  return value;
}

function number(entity: DxfEntity, code: number, fallback?: number): number {
  const found = singleGroup(entity, code);
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
  const thickness = singleGroup(entity, 39);
  if (thickness && dxfNumber(thickness.value) !== 0) return false;
  // A LINE's endpoints are world coordinates, so with no thickness its
  // extrusion direction moves nothing; only OCS entities (circles, arcs,
  // polylines) are placed by it.
  if (entity.type === 'LINE') return true;
  const z = singleGroup(entity, 230);
  const x = singleGroup(entity, 210);
  const y = singleGroup(entity, 220);
  if (!z && !x && !y) return true;
  return (
    dxfNumber(x?.value ?? '0') === 0 &&
    dxfNumber(y?.value ?? '0') === 0 &&
    dxfNumber(z?.value ?? '1') > 0
  );
}

/** The region builder's closed-circle tolerance (1e-9 rad), in degrees. */
const FULL_TURN_TOLERANCE_DEG = (1e-9 * 180) / Math.PI;

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
  // step moves an endpoint off the geometry it should meet. `%` is exact,
  // and a whole turn is only added to an angle it does not round: the usual
  // start in [0, 360) with end above it whenever that is exact, else the
  // turn goes on the other angle, so a tiny angle (positive or negative) is
  // never rounded into 0 or 360.
  let start = startDeg % 360;
  let end = endDeg % 360;
  // Coincident ends are a zero sweep, never a whole turn: DXF draws a full
  // circle as a CIRCLE, and an ARC from 45° to 45° has no extent.
  if ((end - start) % 360 === 0) {
    throw new DxfImportError(
      distinctEnds
        ? 'This DXF has a polyline bulge too extreme to convert exactly.'
        : 'This DXF has an arc too short to represent: its sweep rounds to zero.'
    );
  }
  const exact = (angle: number, turn: number) => angle + turn - turn === angle;
  if (start < 0 && exact(start, 360) && exact(end, 360)) {
    start += 360;
    end += 360;
  }
  while (end - start <= 0) {
    if (exact(end, 360) || !exact(start, -360)) end += 360;
    else start -= 360;
  }
  while (end - start > 360) {
    if (exact(end, -360) || !exact(start, 360)) end -= 360;
    else start += 360;
  }
  if (!(end > start)) {
    throw new DxfImportError(
      'This DXF has an arc too short to represent: its sweep rounds to zero.'
    );
  }
  // Coincident ends were refused above, so a sweep that is now a whole turn
  // means the turn added to straddle zero rounded the gap away (both ends
  // too close to 0 for 360 to keep their digits): refuse, never close it.
  // The sketch's region builder also reads any sweep within 1e-9 rad of a
  // turn as a closed circle, so a gap that small is refused too.
  if (end - start >= 360 - FULL_TURN_TOLERANCE_DEG) {
    throw new DxfImportError(
      distinctEnds
        ? 'This DXF has a polyline bulge too extreme to convert exactly.'
        : 'This DXF has an arc whose gap is too small to represent: it would close into a full turn.'
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
  // it has a meaning the sketch would lose. No length threshold applies
  // here, in the drawing's own units: whether geometry is too small is
  // decided once it is in the document's units, so a unit declaration
  // never changes what imports.
  if (chord === 0 && bulge === 0) return null;
  if (chord === 0) {
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
  // The sketch keeps an arc as centre, radius and angles, and rebuilds its
  // ends from those. A very shallow bulge puts the centre so far away that
  // the angles cannot hold the ends: refuse rather than open a gap where
  // this segment met its neighbours.
  // The allowance is the segment's own (1e-9 of its chord), widened only to
  // the rounding a double carries at the vertices' coordinates (never the
  // centre's: a far centre is the very thing that loses the ends).
  const tolerance = Math.max(
    1e-9 * chord,
    16 *
      Number.EPSILON *
      Math.max(
        Math.abs(from.x),
        Math.abs(from.y),
        Math.abs(to.x),
        Math.abs(to.y)
      )
  );
  for (const point of [from, to]) {
    const radians = (angle(point) * Math.PI) / 180;
    const rebuilt = {
      x: centerX + radius * Math.cos(radians),
      y: centerY + radius * Math.sin(radians)
    };
    if (
      !(Math.abs(rebuilt.x - point.x) <= tolerance) ||
      !(Math.abs(rebuilt.y - point.y) <= tolerance)
    ) {
      throw new DxfImportError(
        'This DXF has a polyline bulge too extreme to convert exactly: an arc could not keep its endpoints.'
      );
    }
  }
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
  let emitted = 0;
  for (let index = 0; index < count; index += 1) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % vertices.length]!;
    const piece = segment(from, to, from.bulge);
    if (piece) {
      add(piece);
      emitted += 1;
    }
  }
  // Empty, a single vertex, or every vertex in one place: the polyline
  // draws nothing, which is not something to leave out without a word.
  if (emitted === 0) {
    throw new DxfImportError(
      'This DXF has a polyline with nothing to draw: no two distinct vertices.'
    );
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
  // The vertex count (90) is how a truncated list is told apart from a
  // short one, so exactly one, matching what was read, is required.
  const declared = entity.groups.filter((pair) => pair.code === 90);
  if (
    pendingX !== null ||
    vertices.some((v) => !Number.isFinite(v.x + v.y + v.bulge)) ||
    declared.length !== 1 ||
    dxfNumber(declared[0]!.value) !== vertices.length
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
  const sections = sectionsOf(pairs);
  const entitiesSection = sections.get('ENTITIES');
  if (!entitiesSection) {
    throw new DxfImportError('This DXF has no ENTITIES section to import.');
  }
  const unitCode = insUnits(sections.get('HEADER'));
  const hidden = hiddenLayers(sections.get('TABLES'));
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
    // VERTEX and SEQEND only exist inside a parent's sequence, which the
    // parent consumes below; met on their own, the parent was lost (a
    // truncated file) and its geometry with it.
    if (entity.type === 'SEQEND' || entity.type === 'VERTEX') {
      throw new DxfImportError(
        `This DXF is malformed: a ${entity.type} has no POLYLINE owning it.`
      );
    }
    if (entity.type === 'ATTRIB') {
      throw new DxfImportError(
        'This DXF is malformed: an ATTRIB has no INSERT owning it.'
      );
    }
    // A POLYLINE owns VERTEX…SEQEND and an INSERT with attributes (66 = 1)
    // owns ATTRIB…SEQEND; the whole sequence is taken here, whatever then
    // happens to the parent (imported, dropped or refused).
    const childType =
      entity.type === 'POLYLINE'
        ? 'VERTEX'
        : entity.type === 'INSERT' && integerFlags(entity, 66) === 1
          ? 'ATTRIB'
          : null;
    const owned: DxfEntity[] = [];
    if (childType) {
      while (entities[index + 1]?.type === childType) {
        index += 1;
        owned.push(entities[index]!);
      }
      // SEQEND is what says the sequence is complete; without it a
      // polyline may be truncated, and would import as a shorter outline.
      if (entities[index + 1]?.type !== 'SEQEND') {
        throw new DxfImportError(
          entity.type === 'POLYLINE'
            ? 'This DXF is malformed: a POLYLINE has no SEQEND closing its vertices.'
            : 'This DXF is malformed: an INSERT has no SEQEND closing its attributes.'
        );
      }
      index += 1;
    }
    if (DROPPED.has(entity.type)) {
      count(dropped, entity.type);
      continue;
    }
    // Paper space (67 = 1) holds layouts — borders, title blocks — not the
    // part; only model space becomes sketch geometry. A paper-space POLYLINE
    // takes its VERTEX records with it, as they were consumed above.
    const space = integerFlags(entity, 67);
    if (space !== 0 && space !== 1) {
      throw new DxfImportError(
        `This DXF is malformed: a ${entity.type} has space marker ${space} (67 must be 0 or 1).`
      );
    }
    if (space === 1) {
      count(dropped, `${entity.type} in paper space`);
      continue;
    }
    // 60 = 1 hides the entity (guides, alternates): left out, reported,
    // never drawn into a profile. Only 0 and 1 mean anything.
    const visibility = integerFlags(entity, 60);
    if (visibility !== 0 && visibility !== 1) {
      throw new DxfImportError(
        `This DXF is malformed: a ${entity.type} has visibility ${visibility} (60 must be 0 or 1).`
      );
    }
    if (visibility === 1) {
      count(dropped, `${entity.type} (invisible)`);
      continue;
    }
    // On a layer that is off or frozen, it is as hidden as group 60 = 1.
    const layerName = singleGroup(entity, 8)?.value ?? '0';
    // Layer names keep their case but compare without it.
    if (hidden.has(layerName.toUpperCase())) {
      count(dropped, `${entity.type} (hidden layer)`);
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
          (integerFlags(entity, 70) & 1) === 1,
          add
        );
        break;
      case 'POLYLINE': {
        const flags = integerFlags(entity, 70);
        const vertexEntities = owned;
        // 3D polylines (8) and meshes (16, 32 closed in N, 64) are not 2D
        // sketch geometry, and neither are their records when the parent
        // flag is missing: VERTEX 32 is a 3D vertex, 64 a mesh vertex, 128
        // a polyface one.
        if (
          (flags & (8 | 16 | 32 | 64)) !== 0 ||
          vertexEntities.some(
            (vertex) => (integerFlags(vertex, 70) & (32 | 64 | 128)) !== 0
          )
        ) {
          count(refused, 'POLYLINE (3D or mesh)');
          break;
        }
        // Curve- (2) and spline-fitted (4) polylines describe a smooth
        // curve their vertices only approximate; joining them with straight
        // segments would change the outline. Also inspect the vertices when
        // the parent flags are missing: 1 is curve-fit generated, 2 carries
        // a curve-fit tangent (significant even when 0), 8 is spline-fit
        // generated, and 16 is a spline frame control point.
        if (
          (flags & (2 | 4)) !== 0 ||
          vertexEntities.some(
            (vertex) => (integerFlags(vertex, 70) & (1 | 2 | 8 | 16)) !== 0
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
  // Last, ask the sketch itself: its region builder drops any curve it
  // judges degenerate at this drawing's scale (a line shorter than its
  // tolerance, an arc sweeping under 1e-9 rad). Imported, such a curve
  // would leave a gap in its profile, so the file is refused instead.
  const analysis = computeSketchProfileAnalysis(
    scaled.map((data, index) => ({ id: String(index), data })),
    (value) => Number(value)
  );
  if (
    analysis.diagnostics.some((entry) => entry.code === 'degenerate-entity')
  ) {
    throw new DxfImportError(
      "This DXF has a curve too small for the sketch to use at this drawing's scale."
    );
  }
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
        // Far from the origin a small radius can vanish in the centre's
        // precision (1e100 + 1 === 1e100): the curve would have no extent.
        const { centerX: cx, centerY: cy, radius: r } = curve;
        if (cx + r === cx || cx - r === cx || cy + r === cy || cy - r === cy) {
          throw degenerate();
        }
        // An arc's ends are rebuilt from centre, radius and angles; far from
        // the origin they can collapse together even when the radius
        // survives. The rebuilt chord must match the one the sweep implies.
        if (curve.objectKind === 'arc') {
          const toRadians = Math.PI / 180;
          const start = Number(curve.startAngleDeg) * toRadians;
          const end = Number(curve.endAngleDeg) * toRadians;
          const point = (angle: number) => ({
            x: cx + r * Math.cos(angle),
            y: cy + r * Math.sin(angle)
          });
          const a = point(start);
          const b = point(end);
          const rebuilt = Math.hypot(b.x - a.x, b.y - a.y);
          const expected = 2 * r * Math.abs(Math.sin((end - start) / 2));
          if (!(Math.abs(rebuilt - expected) <= 1e-6 * expected)) {
            throw degenerate();
          }
        }
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
