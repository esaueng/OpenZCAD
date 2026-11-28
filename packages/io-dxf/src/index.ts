/**
 * Minimal DXF R12 (AC1009) writer for 2D face-outline export.
 *
 * Emits only what laser-cutting and CAM tools consume: LINE, CIRCLE, ARC,
 * and POLYLINE/VERTEX/SEQEND entities on layer 0, in millimetres. R12 is
 * deliberate — it is the most widely accepted dialect among hobby and
 * industrial cutters alike, and everything this exporter needs exists in it
 * (LWPOLYLINE would require R13+).
 *
 * The writer is pure text assembly over already-projected 2D entities; the
 * geometry extraction from a B-Rep face lives with the kernel adapter, not
 * here.
 */

export interface DxfLine {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'line';
  readonly start: readonly [number, number];
  readonly end: readonly [number, number];
}

export interface DxfCircle {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'circle';
  readonly center: readonly [number, number];
  readonly radius: number;
}

/** A circular arc, counter-clockwise from `startAngle` to `endAngle` (degrees). */
export interface DxfArc {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'arc';
  readonly center: readonly [number, number];
  readonly radius: number;
  readonly startAngleDeg: number;
  readonly endAngleDeg: number;
}

export interface DxfPolyline {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'polyline';
  readonly points: ReadonlyArray<readonly [number, number]>;
  readonly closed: boolean;
  /**
   * Run a dashed line type's pattern on along the whole polyline (flag
   * 128) instead of restarting it at every vertex, where a finely sampled
   * curve would otherwise draw solid. Absent writes the flags as before.
   */
  readonly continuousLinetype?: true;
}

/**
 * An ellipse or elliptical arc (I01), counter-clockwise in its parameter
 * from `startParam` to `endParam` (radians; 0 to 2π for a full ellipse).
 * `majorAxis` is the vector from the centre to the end of the axis that
 * carries the larger radius, and `ratio` the minor radius over the major —
 * the shape of a DXF ELLIPSE, which R12 itself does not have.
 */
export interface DxfEllipse {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'ellipse';
  readonly center: readonly [number, number];
  readonly majorAxis: readonly [number, number];
  readonly ratio: number;
  readonly startParam: number;
  readonly endParam: number;
}

/**
 * A non-rational clamped B-spline (I01): `knots.length` is the control
 * count plus `degree + 1`. DXF SPLINE carries exactly this; R12 does not.
 */
export interface DxfSpline {
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly kind: 'spline';
  readonly degree: number;
  readonly knots: readonly number[];
  readonly controls: ReadonlyArray<readonly [number, number]>;
}

/**
 * Single-line text (TEXT). `position` is the insertion point; with an
 * alignment other than `left` it is also written as the alignment point
 * (group 11), which is where readers place aligned text.
 */
export interface DxfText {
  readonly kind: 'text';
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly position: readonly [number, number];
  readonly height: number;
  readonly text: string;
  /** Degrees, counter-clockwise; absent is 0. */
  readonly rotationDeg?: number;
  /** Horizontal alignment; absent is `left`. */
  readonly align?: 'left' | 'center' | 'right';
}

/**
 * A filled triangle or quadrilateral (R12 SOLID): a dimension's arrowhead.
 * Corners go round the outline in order; the writer emits them in the
 * SOLID's own 1-2-4-3 order.
 */
export interface DxfSolid {
  readonly kind: 'solid';
  /** Layer name; absent is `0`. */
  readonly layer?: string;
  readonly points:
    | readonly [
        readonly [number, number],
        readonly [number, number],
        readonly [number, number]
      ]
    | readonly [
        readonly [number, number],
        readonly [number, number],
        readonly [number, number],
        readonly [number, number]
      ];
}

export type DxfEntity =
  | DxfText
  | DxfLine
  | DxfCircle
  | DxfArc
  | DxfPolyline
  | DxfEllipse
  | DxfSpline
  | DxfSolid;

/**
 * DXF forbids exponent notation, so plain `toString` (which yields `1e-7`
 * for small values) would corrupt the file. Fixed-point with trailing zeros
 * trimmed keeps files small and exact to a nanometre. `toFixed` itself falls
 * back to exponent notation at |value| >= 1e21, so magnitudes beyond any
 * plausible model are refused rather than emitted corrupt.
 */
export function formatDxfNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`DXF coordinate is not finite: ${value}`);
  }
  if (Math.abs(value) >= 1e21) {
    throw new Error(`DXF coordinate out of range: ${value}`);
  }
  const fixed = value.toFixed(9);
  const trimmed = fixed.replace(/\.?0+$/, '');
  // "-0" survives toFixed for tiny negatives; normalize it.
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

function group(code: number, value: string | number): string[] {
  return [
    String(code),
    typeof value === 'number' ? formatDxfNumber(value) : value
  ];
}

/**
 * Layer names are symbol-table names: R12 allows letters, digits, `$`,
 * `-` and `_`, up to 31 characters. Anything else is refused rather than
 * written, since a reader that rejects the name drops the whole file.
 */
const LAYER_NAME = /^[A-Za-z0-9$_-]{1,31}$/;

function layerName(layer: string | undefined): string {
  const name = layer ?? '0';
  if (!LAYER_NAME.test(name)) {
    throw new Error(
      `DXF layer name is not valid in R12: ${JSON.stringify(name)}`
    );
  }
  return name;
}

/**
 * R12 TEXT is one line of 8-bit text. Line breaks are refused, and
 * characters outside printable ASCII are written as `\U+XXXX` escapes,
 * which AutoCAD-compatible readers show as the character.
 */
/** Readers (AutoCAD among them) reject a file with a longer string value. */
const MAX_DXF_STRING_LENGTH = 256;
/** The most characters one TEXT may hold once encoded (see `dxfTextLength`). */
export const MAX_DXF_TEXT_LENGTH = MAX_DXF_STRING_LENGTH;

/**
 * How long `text` is once written as a TEXT value: printable ASCII is one
 * character, anything else its 7-character `\U+XXXX` escape. A caller with
 * longer text splits it into several entities.
 */
export function dxfTextLength(text: string): number {
  let length = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    length += code >= 0x20 && code < 0x7f ? 1 : 7;
  }
  return length;
}

function dxfTextValue(text: string): string {
  if (/[\r\n]/.test(text)) {
    throw new Error(
      'DXF TEXT is a single line; split multi-line notes into separate entities.'
    );
  }
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) {
      out += char;
    } else if (code <= 0xffff && code >= 0xa0) {
      out += `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      throw new Error(
        `DXF TEXT cannot carry the character U+${code.toString(16).toUpperCase()}.`
      );
    }
  }
  if (out.length > MAX_DXF_STRING_LENGTH) {
    throw new Error(
      `DXF TEXT is limited to ${MAX_DXF_STRING_LENGTH} characters once encoded; this note needs ${out.length}.`
    );
  }
  return out;
}

function textEntity(entity: DxfText): string[] {
  if (!Number.isFinite(entity.height) || entity.height <= 0) {
    throw new Error(`DXF text height must be positive: ${entity.height}`);
  }
  const align = entity.align ?? 'left';
  const out = [
    ...group(0, 'TEXT'),
    ...group(8, layerName(entity.layer)),
    ...group(10, entity.position[0]),
    ...group(20, entity.position[1]),
    ...group(30, 0),
    ...group(40, entity.height),
    ...group(1, dxfTextValue(entity.text))
  ];
  if (entity.rotationDeg !== undefined && entity.rotationDeg !== 0) {
    out.push(...group(50, entity.rotationDeg));
  }
  if (align !== 'left') {
    out.push(
      ...group(72, align === 'center' ? '1' : '2'),
      ...group(11, entity.position[0]),
      ...group(21, entity.position[1]),
      ...group(31, 0)
    );
  }
  return out;
}

function lineEntity(entity: DxfLine): string[] {
  return [
    ...group(0, 'LINE'),
    ...group(8, layerName(entity.layer)),
    ...group(10, entity.start[0]),
    ...group(20, entity.start[1]),
    ...group(30, 0),
    ...group(11, entity.end[0]),
    ...group(21, entity.end[1]),
    ...group(31, 0)
  ];
}

function circleEntity(entity: DxfCircle): string[] {
  return [
    ...group(0, 'CIRCLE'),
    ...group(8, layerName(entity.layer)),
    ...group(10, entity.center[0]),
    ...group(20, entity.center[1]),
    ...group(30, 0),
    ...group(40, entity.radius)
  ];
}

function arcEntity(entity: DxfArc): string[] {
  return [
    ...group(0, 'ARC'),
    ...group(8, layerName(entity.layer)),
    ...group(10, entity.center[0]),
    ...group(20, entity.center[1]),
    ...group(30, 0),
    ...group(40, entity.radius),
    ...group(50, entity.startAngleDeg),
    ...group(51, entity.endAngleDeg)
  ];
}

function solidEntity(entity: DxfSolid): string[] {
  const [a, b, c, d = c] = entity.points;
  // SOLID fills 1-2-3 and 2-3-4 (its third and fourth corners swap
  // against the outline's order); a triangle repeats its last corner.
  const corners = [a, b, d, c];
  const out = [...group(0, 'SOLID'), ...group(8, layerName(entity.layer))];
  corners.forEach(([x, y], index) => {
    out.push(
      ...group(10 + index, x),
      ...group(20 + index, y),
      ...group(30 + index, 0)
    );
  });
  return out;
}

function polylineEntity(entity: DxfPolyline): string[] {
  const layer = layerName(entity.layer);
  const out = [
    ...group(0, 'POLYLINE'),
    ...group(8, layer),
    // 66=1: vertices follow as separate entities (required in R12).
    ...group(66, '1'),
    ...group(
      70,
      String((entity.closed ? 1 : 0) | (entity.continuousLinetype ? 128 : 0))
    )
  ];
  for (const [x, y] of entity.points) {
    out.push(
      ...group(0, 'VERTEX'),
      ...group(8, layer),
      ...group(10, x),
      ...group(20, y),
      ...group(30, 0)
    );
  }
  out.push(...group(0, 'SEQEND'));
  return out;
}

/**
 * A layer declared in the file's LAYER table, so readers show its colour,
 * line type and name instead of inventing defaults. `color` is an AutoCAD
 * Color Index 1-255 (absent is 7, white/black); `lineType` is `CONTINUOUS`
 * (absent) or `DASHED`.
 */
export interface DxfLayer {
  readonly name: string;
  readonly color?: number;
  /**
   * `DASHED` (0.5/0.25 mm, the flat-pattern bend lines), `HIDDEN` (ISO 128
   * type 02, 3/1.5 mm) or `CENTER` (ISO 128 type 04 long-dash-dot,
   * 12/1.5/0.5/1.5 mm); absent is `CONTINUOUS`.
   */
  readonly lineType?: 'CONTINUOUS' | 'DASHED' | 'HIDDEN' | 'CENTER';
}

/**
 * The patterns of the non-continuous line types, in millimetres. The
 * writer converts them to the file's declared unit, so a dash is the same
 * physical length in a millimetre and an inch file.
 */
const LINE_TYPE_PATTERNS: Readonly<
  Record<'DASHED' | 'HIDDEN' | 'CENTER', { text: string; dashes: number[] }>
> = {
  DASHED: { text: 'Dashed __ __ __', dashes: [0.5, -0.25] },
  HIDDEN: { text: 'Hidden __ __ __', dashes: [3, -1.5] },
  CENTER: { text: 'Center ____ _ ____', dashes: [12, -1.5, 0.5, -1.5] }
};

function layerTables(
  layers: readonly DxfLayer[],
  units: DxfLengthUnit
): string[] {
  const unitMm = MILLIMETRES_PER_UNIT[units];
  // Layer names are case-insensitive: readers merge `BEND_UP` and `bend_up`
  // into one layer and keep only the last declaration's colour and type.
  const names = new Set<string>();
  for (const layer of layers) {
    layerName(layer.name);
    const key = layer.name.toUpperCase();
    if (names.has(key)) {
      throw new Error(`DXF layer declared twice: ${layer.name}`);
    }
    names.add(key);
    if (
      layer.color !== undefined &&
      !(Number.isInteger(layer.color) && layer.color >= 1 && layer.color <= 255)
    ) {
      throw new Error(
        `DXF layer colour must be an ACI index 1-255: ${layer.color}`
      );
    }
  }
  // Each pattern used, once, in a fixed order, so a file that names only
  // DASHED writes the bytes it always has.
  const patterns = (['DASHED', 'HIDDEN', 'CENTER'] as const).filter((type) =>
    layers.some((layer) => layer.lineType === type)
  );
  const lineTypes: string[] = [
    ...group(0, 'TABLE'),
    ...group(2, 'LTYPE'),
    ...group(70, String(1 + patterns.length)),
    ...group(0, 'LTYPE'),
    ...group(2, 'CONTINUOUS'),
    ...group(70, '0'),
    ...group(3, 'Solid line'),
    ...group(72, '65'),
    ...group(73, '0'),
    ...group(40, 0)
  ];
  for (const type of patterns) {
    const { text } = LINE_TYPE_PATTERNS[type];
    const dashes = LINE_TYPE_PATTERNS[type].dashes.map((dash) => dash / unitMm);
    lineTypes.push(
      ...group(0, 'LTYPE'),
      ...group(2, type),
      ...group(70, '0'),
      ...group(3, text),
      ...group(72, '65'),
      ...group(73, String(dashes.length)),
      ...group(
        40,
        dashes.reduce((total, dash) => total + Math.abs(dash), 0)
      ),
      ...dashes.flatMap((dash) => group(49, dash))
    );
  }
  lineTypes.push(...group(0, 'ENDTAB'));
  const layerTable: string[] = [
    ...group(0, 'TABLE'),
    ...group(2, 'LAYER'),
    ...group(70, String(layers.length))
  ];
  for (const layer of layers) {
    layerTable.push(
      ...group(0, 'LAYER'),
      ...group(2, layer.name),
      ...group(70, '0'),
      ...group(62, String(layer.color ?? 7)),
      ...group(6, layer.lineType ?? 'CONTINUOUS')
    );
  }
  layerTable.push(...group(0, 'ENDTAB'));
  return [
    ...group(0, 'SECTION'),
    ...group(2, 'TABLES'),
    ...lineTypes,
    ...layerTable,
    ...group(0, 'ENDSEC')
  ];
}

/** The lengths a DXF header can declare, with their `$INSUNITS` codes. */
export type DxfLengthUnit = 'mm' | 'cm' | 'm' | 'inch';

const INSUNITS_CODE: Record<DxfLengthUnit, string> = {
  inch: '1',
  mm: '4',
  cm: '5',
  m: '6'
};

/** One drawing unit in millimetres, for the line-type patterns. */
const MILLIMETRES_PER_UNIT: Record<DxfLengthUnit, number> = {
  inch: 25.4,
  mm: 1,
  cm: 10,
  m: 1000
};

/**
 * Assemble a complete R12 document from 2D entities.
 *
 * The header carries `$ACADVER` plus the two variables that state the unit:
 * `$INSUNITS` (4 millimetres, 5 centimetres, 6 metres, 1 inches) and
 * `$MEASUREMENT` (1 metric, 0 imperial drawing setup). A file whose header
 * says nothing is imported at whatever the reader happens to default to,
 * which is how a 50 mm slot arrives at a cutter 25.4 times too large.
 * Everything else stays out: each additional header variable is another
 * thing an importer can choke on. Coordinates are emitted as given; callers
 * are responsible for having scaled them to `options.units` (millimetres
 * unless they say otherwise). Line-type dash lengths are the one thing the
 * writer scales itself: they are fixed physical lengths, written in
 * `options.units`.
 */
export function writeDxf(
  entities: readonly DxfEntity[],
  options: { units?: DxfLengthUnit; layers?: readonly DxfLayer[] } = {}
): string {
  const units = options.units ?? 'mm';
  const lines: string[] = [
    ...group(0, 'SECTION'),
    ...group(2, 'HEADER'),
    ...group(9, '$ACADVER'),
    ...group(1, 'AC1009'),
    ...group(9, '$INSUNITS'),
    ...group(70, INSUNITS_CODE[units]),
    ...group(9, '$MEASUREMENT'),
    ...group(70, units === 'inch' ? '0' : '1'),
    ...group(0, 'ENDSEC')
  ];
  if (options.layers && options.layers.length > 0) {
    lines.push(...layerTables(options.layers, units));
  }
  lines.push(...group(0, 'SECTION'), ...group(2, 'ENTITIES'));
  for (const entity of entities) {
    switch (entity.kind) {
      case 'text':
        lines.push(...textEntity(entity));
        break;
      case 'line':
        lines.push(...lineEntity(entity));
        break;
      case 'circle':
        lines.push(...circleEntity(entity));
        break;
      case 'arc':
        lines.push(...arcEntity(entity));
        break;
      case 'polyline':
        lines.push(...polylineEntity(entity));
        break;
      case 'solid':
        lines.push(...solidEntity(entity));
        break;
      case 'ellipse':
      case 'spline':
        // ELLIPSE and SPLINE arrived in R13; an R12 file could carry them
        // only as a sampled POLYLINE, which this writer never emits.
        throw new Error(
          `DXF R12 has no ${entity.kind === 'ellipse' ? 'ELLIPSE' : 'SPLINE'} entity, so an ${entity.kind === 'ellipse' ? 'ellipse' : 'spline'} cannot be written exactly; export the sketch as SVG instead.`
        );
    }
  }
  lines.push(...group(0, 'ENDSEC'), ...group(0, 'EOF'));
  return `${lines.join('\r\n')}\r\n`;
}
