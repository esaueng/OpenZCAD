/**
 * OBJ and PLY state no length unit, so their numbers mean whatever the user
 * says they mean — and the import has to know that before anything
 * tolerance-sensitive reads them (#2096).
 *
 * The translator, the tessellation that turns its solids back into triangles
 * and the rebuild check that proves a file can become one body all work on
 * the numbers they are handed. Reading an inch file as millimetres and
 * multiplying by 25.4 afterwards asks every one of them a question 25.4 times
 * smaller than the one the stored mesh will pose, so the same physical part
 * could import differently from an inch file and from a millimetre one.
 *
 * The pinned translator takes a byte budget and an entity budget and nothing
 * else — no unit scale, and a weld distance fixed inside it — so the only way
 * to hand it millimetres is to hand it a millimetre file:
 *
 * - {@link unitlessMeshExtent} reads a file's raw coordinate extent, cheaply
 *   and without the kernel, so the unit prompt can size each choice before
 *   the import runs.
 * - {@link scaleUnitlessMeshFile} rewrites the vertex coordinates of the file
 *   itself into millimetres, so the import runs on exactly the bytes a
 *   millimetre copy of the same part would have.
 *
 * A rewrite is only as good as its agreement with the translator about which
 * numbers are positions: a vertex one of them reads and the other does not is
 * a corner left 25.4 times too small. So nothing here is a lenient parser.
 * Each scan follows the pinned reader's own syntax (`crates/io/src/obj/reader.rs`
 * and `ply/reader.rs`: lines end at a line feed only, tokens split on
 * Unicode white space, numbers are Rust's), every position it will read is
 * rewritten, and a file that departs from that syntax where a position is
 * concerned is refused by name instead of being passed on as written. The
 * finished file is then read back a second, independent way, and refused
 * unless that count and extent are the ones the rewrite produced.
 *
 * Only vertex positions change, and a PLY position stored as an integer —
 * which cannot hold its own value times 25.4 — becomes a double. Everything
 * else — faces, normals, texture coordinates, colours, comments, element
 * order — is copied byte for byte.
 */

export type UnitlessMeshFormat = 'obj' | 'ply';

/** What a rewrite may cost, enforced while it scans rather than after. */
export interface UnitlessMeshBudget {
  /** How a refusal names the format to the user. */
  readonly label: string;
  /** The translator's own vertex ceiling: a file over it is refused anyway. */
  readonly maxVertices: number;
  /** The rewritten file may spell the same numbers in more digits. */
  readonly maxOutputBytes: number;
}

const FORMAT_LABELS: Record<UnitlessMeshFormat, string> = {
  obj: 'OBJ',
  ply: 'PLY'
};

/** A file whose positions cannot all be found, and so cannot all be scaled. */
class UnitlessMeshRefusal extends Error {}

type Refuse = (reason: string) => never;

function refusalFor(label: string): Refuse {
  return (reason) => {
    throw new UnitlessMeshRefusal(
      `This ${label} file cannot be read in the chosen unit: ${reason}.`
    );
  };
}

const OUT_OF_RANGE =
  'This file places a vertex beyond the range a number can hold in the chosen unit.';

const LINE_FEED = 0x0a;
const SPACE = 0x20;
const LOWER_V = 0x76;

/** Rust's `char::is_whitespace`, below U+0080. */
function isAsciiSpace(byte: number): boolean {
  return byte === SPACE || (byte >= 0x09 && byte <= 0x0d);
}

/**
 * Rust's `char::is_whitespace` (Unicode `White_Space`), which is what the
 * translator's `trim` and `split_whitespace` use. JavaScript's `\s` is not
 * the same set: it lacks U+0085 and adds U+FEFF, the byte-order mark.
 */
const RUST_SPACE =
  '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const TOKEN = new RegExp(`[^${RUST_SPACE}]+`, 'g');

/**
 * What Rust's `f64::from_str` and `f32::from_str` read as a finite number:
 * digits with an optional point and exponent. No hexadecimal, no blank, no
 * separators — the things `Number()` would add.
 */
const RUST_DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
/** What they read as a number that is not one a vertex can sit at. */
const RUST_NON_FINITE = /^[+-]?(?:inf|infinity|nan)$/i;
const RUST_INTEGER = /^[+-]?\d+$/;

// The mark is kept and bad bytes throw: `TextDecoder`'s defaults would drop
// one and replace the other, and the translator does neither.
const strictDecoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true
});
const encoder = new TextEncoder();

function decodeLine(
  data: Uint8Array,
  start: number,
  end: number,
  refuse: Refuse
): string {
  try {
    return strictDecoder.decode(data.subarray(start, end));
  } catch {
    return refuse('it is not UTF-8 text');
  }
}

function quoted(token: string): string {
  return `"${token.length > 40 ? `${token.slice(0, 40)}…` : token}"`;
}

/** A finite number as Rust reads it, or a refusal that names the token. */
function finiteDecimal(token: string, what: string, refuse: Refuse): number {
  if (!RUST_DECIMAL.test(token)) {
    return refuse(
      `${what} that is not a ${RUST_NON_FINITE.test(token) ? 'finite ' : ''}number (${quoted(token)})`
    );
  }
  const value = Number(token);
  return Number.isFinite(value)
    ? value
    : refuse(`${what} that is not a finite number (${quoted(token)})`);
}

/** The bounding box and count of the positions a scan visited. */
class Extent {
  readonly min = [Infinity, Infinity, Infinity];
  readonly max = [-Infinity, -Infinity, -Infinity];
  count = 0;

  add(values: readonly number[]): void {
    this.count += 1;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = values[axis]!;
      if (value < this.min[axis]!) this.min[axis] = value;
      if (value > this.max[axis]!) this.max[axis] = value;
    }
  }

  size(): number[] | null {
    return this.count === 0
      ? null
      : this.min.map((low, axis) => this.max[axis]! - low);
  }

  matches(other: Extent): boolean {
    return (
      this.count === other.count &&
      this.min.every((value, axis) => value === other.min[axis]) &&
      this.max.every((value, axis) => value === other.max[axis])
    );
  }
}

/**
 * Width, depth and height of the positions the translator will read from a
 * file, or null if it has none — or if the file is one a unit conversion
 * would refuse, which the import then names.
 */
export function unitlessMeshExtent(
  format: UnitlessMeshFormat,
  data: Uint8Array
): number[] | null {
  const refuse = refusalFor(FORMAT_LABELS[format]);
  const extent = new Extent();
  try {
    if (format === 'obj') {
      scanObjVertices(data, refuse, (vertex) => extent.add(vertex.values));
    } else {
      const layout = readPlyLayout(data, refuse);
      walkPlyVertices(data, layout, refuse, (vertex) =>
        extent.add(vertex.values)
      );
    }
  } catch (error) {
    if (error instanceof UnitlessMeshRefusal) return null;
    throw error;
  }
  return extent.size();
}

/**
 * The file with every vertex position multiplied by `factor`.
 *
 * Throws, with a message for the user, when that cannot be guaranteed: a
 * file whose positions this cannot find exactly as the translator will, a
 * position that is not a finite number, a budget exceeded, or a rewritten
 * file that does not read back as the rewrite intended. It never returns a
 * file some of whose positions are still in the old unit.
 */
export function scaleUnitlessMeshFile(
  format: UnitlessMeshFormat,
  data: Uint8Array,
  factor: number,
  budget: UnitlessMeshBudget = {
    label: FORMAT_LABELS[format],
    maxVertices: Infinity,
    maxOutputBytes: Infinity
  }
): Uint8Array {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`Unit scale must be a positive number: ${factor}.`);
  }
  if (factor === 1) return data;
  const refuse = refusalFor(budget.label);
  return format === 'obj'
    ? scaleObj(data, factor, budget, refuse)
    : scalePly(data, factor, budget, refuse);
}

function assertVertexBudget(count: number, budget: UnitlessMeshBudget): void {
  if (count > budget.maxVertices) {
    throw new Error(
      `${budget.label} has more than ${budget.maxVertices} vertices; ` +
        `the import limit is ${budget.maxVertices}.`
    );
  }
}

const UNCONVERTED =
  'its vertex positions could not all be converted; convert it to millimeters first';

// ---------------------------------------------------------------------------
// Output

/**
 * One growing buffer for the rewritten file, refused the moment it would
 * pass its limit. The rewrite used to keep two views per vertex and join
 * them at the end, which for a file of many short lines cost a hundred times
 * the file before any budget was looked at.
 */
class BoundedWriter {
  private bytes: Uint8Array;
  private length = 0;
  private readonly scratch = new DataView(new ArrayBuffer(8));

  constructor(
    sourceLength: number,
    private readonly budget: UnitlessMeshBudget
  ) {
    this.bytes = new Uint8Array(
      Math.min(budget.maxOutputBytes, sourceLength + (sourceLength >> 3) + 64)
    );
  }

  private reserve(extra: number): void {
    const needed = this.length + extra;
    if (needed > this.budget.maxOutputBytes) {
      throw new Error(
        `This ${this.budget.label} file is too large to read in the chosen unit; convert it to millimeters first.`
      );
    }
    if (needed <= this.bytes.length) return;
    const grown = new Uint8Array(
      Math.min(
        this.budget.maxOutputBytes,
        Math.max(needed, this.bytes.length * 2)
      )
    );
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  copy(source: Uint8Array, start: number, end: number): void {
    const count = end - start;
    if (count <= 0) return;
    this.reserve(count);
    if (count < 64) {
      for (let index = 0; index < count; index += 1) {
        this.bytes[this.length + index] = source[start + index]!;
      }
    } else {
      this.bytes.set(source.subarray(start, end), this.length);
    }
    this.length += count;
  }

  /** `ascii` when every character is below U+0080, so none needs encoding. */
  text(text: string, ascii: boolean): void {
    if (!ascii) {
      const encoded = encoder.encode(text);
      this.copy(encoded, 0, encoded.length);
      return;
    }
    this.reserve(text.length);
    for (let index = 0; index < text.length; index += 1) {
      this.bytes[this.length + index] = text.charCodeAt(index);
    }
    this.length += text.length;
  }

  float(value: number, double: boolean, littleEndian: boolean): void {
    const size = double ? 8 : 4;
    if (double) this.scratch.setFloat64(0, value, littleEndian);
    else this.scratch.setFloat32(0, value, littleEndian);
    this.reserve(size);
    for (let index = 0; index < size; index += 1) {
      this.bytes[this.length + index] = this.scratch.getUint8(index);
    }
    this.length += size;
  }

  finish(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

// ---------------------------------------------------------------------------
// OBJ

/** One `v` statement: its line, and where its three coordinates are in it. */
interface ObjVertex {
  lineStart: number;
  lineEnd: number;
  /** The line, decoded; the offsets below are into this. */
  text: string;
  readonly starts: number[];
  readonly ends: number[];
  readonly values: number[];
}

/**
 * Calls `visit` for every statement the translator reads as a vertex
 * position, in file order, and refuses a file in which one of them does not
 * hold three finite numbers.
 *
 * As the translator: a line ends at a line feed and nowhere else, is trimmed
 * of Unicode white space, is skipped when blank or starting with `#`, and is
 * a vertex when its first white-space-separated token is exactly `v` — not
 * `vn`, `vt` or `vp`. The next three tokens are the position; any after them
 * (a weight, colours, a trailing comment) are not read.
 *
 * Lines are classified on their bytes, so a file of faces costs no decoding:
 * only a line that starts `v` + white space, or whose first character is not
 * ASCII and so might be white space, is decoded and tokenized.
 */
function scanObjVertices(
  data: Uint8Array,
  refuse: Refuse,
  visit: (vertex: ObjVertex) => void
): void {
  const vertex: ObjVertex = {
    lineStart: 0,
    lineEnd: 0,
    text: '',
    starts: [0, 0, 0],
    ends: [0, 0, 0],
    values: [0, 0, 0]
  };
  let lineNumber = 0;
  for (let start = 0; start < data.length;) {
    let end = data.indexOf(LINE_FEED, start);
    if (end < 0) end = data.length;
    lineNumber += 1;
    let cursor = start;
    while (cursor < end && isAsciiSpace(data[cursor]!)) cursor += 1;
    if (cursor < end) {
      const first = data[cursor]!;
      const after = cursor + 1 < end ? data[cursor + 1]! : SPACE;
      if (
        first >= 0x80 ||
        (first === LOWER_V && (after >= 0x80 || isAsciiSpace(after)))
      ) {
        const text = decodeLine(data, start, end, refuse);
        TOKEN.lastIndex = 0;
        if (TOKEN.exec(text)?.[0] === 'v') {
          for (let axis = 0; axis < 3; axis += 1) {
            const token = TOKEN.exec(text);
            if (!token) {
              return refuse(
                `line ${lineNumber} does not give its vertex three coordinates`
              );
            }
            vertex.starts[axis] = token.index;
            vertex.ends[axis] = token.index + token[0].length;
            vertex.values[axis] = finiteDecimal(
              token[0],
              `line ${lineNumber} has a vertex coordinate`,
              refuse
            );
          }
          vertex.lineStart = start;
          vertex.lineEnd = end;
          vertex.text = text;
          visit(vertex);
        }
      }
    }
    start = end + 1;
  }
}

/** `text` with the three token ranges replaced by `values`, in line order. */
function respell(
  text: string,
  starts: readonly number[],
  ends: readonly number[],
  values: readonly number[],
  order: readonly number[]
): string {
  let rewritten = '';
  let cursor = 0;
  for (const axis of order) {
    rewritten += text.slice(cursor, starts[axis]) + String(values[axis]);
    cursor = ends[axis]!;
  }
  return rewritten + text.slice(cursor);
}

const IN_ORDER = [0, 1, 2];

function scaleObj(
  data: Uint8Array,
  factor: number,
  budget: UnitlessMeshBudget,
  refuse: Refuse
): Uint8Array {
  const writer = new BoundedWriter(data.length, budget);
  const written = new Extent();
  const scaled = [0, 0, 0];
  let copied = 0;
  scanObjVertices(data, refuse, (vertex) => {
    assertVertexBudget(written.count + 1, budget);
    for (let axis = 0; axis < 3; axis += 1) {
      scaled[axis] = vertex.values[axis]! * factor;
      if (!Number.isFinite(scaled[axis])) throw new Error(OUT_OF_RANGE);
    }
    written.add(scaled);
    writer.copy(data, copied, vertex.lineStart);
    writer.text(
      respell(vertex.text, vertex.starts, vertex.ends, scaled, IN_ORDER),
      vertex.text.length === vertex.lineEnd - vertex.lineStart
    );
    copied = vertex.lineEnd;
  });
  if (written.count === 0) return data;
  writer.copy(data, copied, data.length);
  const out = writer.finish();
  if (!recountObjVertices(out, refuse).matches(written)) refuse(UNCONVERTED);
  return out;
}

const OBJ_STATEMENT = new RegExp(`^[${RUST_SPACE}]*v(?:[${RUST_SPACE}]|$)`);
const OBJ_POSITION = new RegExp(
  `^[${RUST_SPACE}]*v[${RUST_SPACE}]+([^${RUST_SPACE}]+)[${RUST_SPACE}]+([^${RUST_SPACE}]+)[${RUST_SPACE}]+([^${RUST_SPACE}]+)`
);

/**
 * The vertex statements of a finished file, read a second way: the whole
 * text decoded as a stream and matched line by line, where the rewrite
 * classified bytes. Its count and extent must be the rewrite's own; a
 * statement the rewrite missed is still in the old unit and shows up here as
 * one more than it wrote.
 */
function recountObjVertices(data: Uint8Array, refuse: Refuse): Extent {
  const found = new Extent();
  const position = [0, 0, 0];
  const line = (text: string) => {
    if (!OBJ_STATEMENT.test(text)) return;
    const match = OBJ_POSITION.exec(text);
    for (let axis = 0; axis < 3; axis += 1) {
      const token = match?.[axis + 1];
      // NaN matches nothing, so an unreadable statement fails the comparison.
      position[axis] =
        token !== undefined && RUST_DECIMAL.test(token) ? Number(token) : NaN;
    }
    found.add(position);
    if (position.some(Number.isNaN)) found.min[0] = NaN;
  };
  const stream = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const CHUNK = 1 << 20;
  // A line longer than a chunk is joined once, when its end is found.
  let pending: string[] = [];
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      const text = stream.decode(
        data.subarray(offset, Math.min(data.length, offset + CHUNK)),
        { stream: true }
      );
      let from = 0;
      for (;;) {
        const at = text.indexOf('\n', from);
        if (at < 0) break;
        if (pending.length > 0) {
          pending.push(text.slice(from, at));
          line(pending.join(''));
          pending = [];
        } else {
          line(text.slice(from, at));
        }
        from = at + 1;
      }
      if (from < text.length) pending.push(text.slice(from));
    }
    pending.push(stream.decode());
  } catch {
    return refuse('it is not UTF-8 text');
  }
  line(pending.join(''));
  return found;
}

// ---------------------------------------------------------------------------
// PLY

type PlyScalar =
  'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';

const PLY_TYPE_ALIASES: Record<string, PlyScalar> = {
  char: 'char',
  int8: 'char',
  uchar: 'uchar',
  uint8: 'uchar',
  short: 'short',
  int16: 'short',
  ushort: 'ushort',
  uint16: 'ushort',
  int: 'int',
  int32: 'int',
  uint: 'uint',
  uint32: 'uint',
  float: 'float',
  float32: 'float',
  double: 'double',
  float64: 'double'
};

const PLY_SIZES: Record<PlyScalar, number> = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8
};

/** Inclusive; the float types have none. */
const PLY_INTEGER_RANGES: Partial<
  Record<PlyScalar, readonly [number, number]>
> = {
  char: [-128, 127],
  uchar: [0, 255],
  short: [-32768, 32767],
  ushort: [0, 65535],
  int: [-2147483648, 2147483647],
  uint: [0, 4294967295]
};

function isFloatType(type: PlyScalar): boolean {
  return type === 'float' || type === 'double';
}

type PlyProperty =
  | {
      kind: 'scalar';
      name: string;
      type: PlyScalar;
      /** Its header line, so a promoted position's type can be respelt. */
      lineStart: number;
      lineEnd: number;
    }
  | { kind: 'list'; name: string; countType: PlyScalar; itemType: PlyScalar };

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

interface PlyLayout {
  encoding: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  /** Byte offset of the first body byte, just past the header's last line. */
  bodyStart: number;
  elements: PlyElement[];
  /** The element positions are read from, when it holds any. */
  vertex: PlyElement | null;
  /** Indices of x, y and z among that element's properties. */
  axes: [number, number, number] | null;
}

/** The translator's bound on a header's declarations. */
const MAX_PLY_DECLARATIONS = 4096;
/** `usize` on the 32-bit target the translator is built for. */
const MAX_PLY_COUNT = 4294967295;
const END_HEADER = [0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72];

/**
 * The words of one header line, or null for a comment — decided from the
 * line's first bytes, so a comment of any length costs nothing to pass.
 */
function plyHeaderWords(
  data: Uint8Array,
  start: number,
  end: number,
  refuse: Refuse
): string[] | null {
  let cursor = start;
  while (cursor < end && isAsciiSpace(data[cursor]!)) cursor += 1;
  let keyword = '';
  while (
    cursor < end &&
    keyword.length < 9 &&
    data[cursor]! < 0x80 &&
    !isAsciiSpace(data[cursor]!)
  ) {
    keyword += String.fromCharCode(data[cursor]!);
    cursor += 1;
  }
  if (
    (keyword === 'comment' || keyword === 'obj_info') &&
    (cursor === end || isAsciiSpace(data[cursor]!))
  ) {
    return null;
  }
  return decodeLine(data, start, end, refuse).match(TOKEN) ?? [];
}

/**
 * The header as the translator reads it, or a refusal.
 *
 * The header ends at the first `end_header` + line feed anywhere in the file
 * — inside a comment if that is where it is, and not at an `end_header`
 * followed by a space or a carriage return. Its lines are then read in
 * order: `ply` first; `comment` and `obj_info` skipped; `format`, `element`
 * and `property` exactly as declared; an `end_header` line stops the
 * reading (the body still starts where the header ended); anything else is
 * not a header the translator accepts. No length limit: the declarations
 * are bounded, the comments between them are not.
 */
function readPlyLayout(data: Uint8Array, refuse: Refuse): PlyLayout {
  let encoding: PlyLayout['encoding'] | null = null;
  const elements: PlyElement[] = [];
  let declarations = 0;
  let stopped = false;
  let bodyStart = -1;
  for (let lineStart = 0, first = true; bodyStart < 0; first = false) {
    const lineEnd = data.indexOf(LINE_FEED, lineStart);
    if (lineEnd < 0) return refuse('its header has no end_header line');
    if (
      lineEnd - lineStart >= END_HEADER.length &&
      END_HEADER.every(
        (byte, index) => data[lineEnd - END_HEADER.length + index] === byte
      )
    ) {
      bodyStart = lineEnd + 1;
    }
    const words = stopped
      ? null
      : plyHeaderWords(data, lineStart, lineEnd, refuse);
    if (first) {
      if (words?.length !== 1 || words[0] !== 'ply') {
        return refuse('it does not start with a ply line');
      }
    } else if (words && words.length > 0) {
      const keyword = words[0]!;
      if (keyword === 'end_header') {
        stopped = true;
      } else if (keyword === 'format') {
        const value = words[1];
        if (
          value !== 'ascii' &&
          value !== 'binary_little_endian' &&
          value !== 'binary_big_endian'
        ) {
          return refuse('its header names a format this import does not read');
        }
        encoding = value;
      } else if (keyword === 'element' || keyword === 'property') {
        declarations += 1;
        if (declarations > MAX_PLY_DECLARATIONS) {
          return refuse('its header declares too many elements and properties');
        }
        if (keyword === 'element') {
          const name = words[1];
          const count = /^\+?\d+$/.test(words[2] ?? '') ? Number(words[2]) : -1;
          if (
            name === undefined ||
            words.length !== 3 ||
            count < 0 ||
            count > MAX_PLY_COUNT
          ) {
            return refuse('its header has an element line it cannot read');
          }
          if (elements.some((element) => element.name === name)) {
            return refuse(`its header declares element ${name} twice`);
          }
          elements.push({ name, count, properties: [] });
        } else {
          const element = elements.at(-1);
          if (!element) {
            return refuse('its header has a property before any element');
          }
          const list = words[1] === 'list';
          const name = words[list ? 4 : 2];
          const type = PLY_TYPE_ALIASES[words[list ? 3 : 1] ?? ''];
          const countType = list ? PLY_TYPE_ALIASES[words[2] ?? ''] : 'uchar';
          if (
            name === undefined ||
            words.length !== (list ? 5 : 3) ||
            !type ||
            !countType ||
            isFloatType(countType)
          ) {
            return refuse('its header has a property line it cannot read');
          }
          if (element.properties.some((property) => property.name === name)) {
            return refuse(`its header declares property ${name} twice`);
          }
          element.properties.push(
            list
              ? { kind: 'list', name, countType, itemType: type }
              : { kind: 'scalar', name, type, lineStart, lineEnd }
          );
        }
      } else {
        return refuse(
          `its header has a line this import does not read (${quoted(keyword)})`
        );
      }
    }
    lineStart = lineEnd + 1;
  }
  if (!encoding) return refuse('its header names no format');
  if (
    elements.some(
      (element) => element.count > 0 && element.properties.length === 0
    )
  ) {
    return refuse('its header declares an element with no properties');
  }
  const vertex = elements.find((element) => element.name === 'vertex') ?? null;
  let axes: PlyLayout['axes'] = null;
  if (vertex) {
    const found = ['x', 'y', 'z'].map((axis) => {
      const index = vertex.properties.findIndex(
        (property) => property.name === axis
      );
      if (index >= 0 && vertex.properties[index]!.kind !== 'scalar') {
        return refuse(`its vertex property ${axis} is not a single number`);
      }
      return index;
    });
    if (found.every((index) => index >= 0)) {
      axes = [found[0]!, found[1]!, found[2]!];
    } else if (vertex.count > 0) {
      return refuse('its vertex element does not declare x, y and z');
    }
  }
  return {
    encoding,
    bodyStart,
    elements,
    // An element of no instances holds no positions, whatever it declares.
    vertex: vertex && vertex.count > 0 && axes ? vertex : null,
    axes
  };
}

/** One vertex: its position, and where the three values are stored. */
interface PlyVertex {
  /** x, y and z, as the declared types read them. */
  readonly values: number[];
  /** Binary: the byte offset of each value. */
  readonly offsets: number[];
  /** ASCII: the vertex's line, decoded, and each value's range in it. */
  lineStart: number;
  lineEnd: number;
  text: string;
  readonly starts: number[];
  readonly ends: number[];
}

/**
 * Calls `visit` for each of the vertex element's instances — exactly as many
 * as the header declares, which is how many the translator reads — or
 * refuses a body that is not laid out as the header says.
 */
function walkPlyVertices(
  data: Uint8Array,
  layout: PlyLayout,
  refuse: Refuse,
  visit: (vertex: PlyVertex) => void
): void {
  if (!layout.vertex || !layout.axes) return;
  const vertex: PlyVertex = {
    values: [0, 0, 0],
    offsets: [0, 0, 0],
    lineStart: 0,
    lineEnd: 0,
    text: '',
    starts: [0, 0, 0],
    ends: [0, 0, 0]
  };
  // For each property of the vertex element, the axis it holds, or -1.
  const axisOf = layout.vertex.properties.map((_property, index) =>
    layout.axes!.indexOf(index)
  );
  if (layout.encoding === 'ascii') {
    walkAsciiPly(data, layout, axisOf, vertex, refuse, visit);
  } else {
    walkBinaryPly(data, layout, axisOf, vertex, refuse, visit);
  }
}

function walkBinaryPly(
  data: Uint8Array,
  layout: PlyLayout,
  axisOf: readonly number[],
  vertex: PlyVertex,
  refuse: Refuse,
  visit: (vertex: PlyVertex) => void
): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const littleEndian = layout.encoding === 'binary_little_endian';
  const read = (type: PlyScalar, offset: number): number => {
    switch (type) {
      case 'char':
        return view.getInt8(offset);
      case 'uchar':
        return view.getUint8(offset);
      case 'short':
        return view.getInt16(offset, littleEndian);
      case 'ushort':
        return view.getUint16(offset, littleEndian);
      case 'int':
        return view.getInt32(offset, littleEndian);
      case 'uint':
        return view.getUint32(offset, littleEndian);
      case 'float':
        return view.getFloat32(offset, littleEndian);
      case 'double':
        return view.getFloat64(offset, littleEndian);
    }
  };
  let offset = layout.bodyStart;
  for (const element of layout.elements) {
    const isVertex = element === layout.vertex;
    for (let row = 0; row < element.count; row += 1) {
      const short = () =>
        refuse(`it ends before ${element.name} ${row + 1} of ${element.count}`);
      for (const [index, property] of element.properties.entries()) {
        if (property.kind === 'scalar') {
          const size = PLY_SIZES[property.type];
          if (offset + size > data.length) return short();
          const axis = isVertex ? axisOf[index]! : -1;
          if (axis >= 0) {
            const value = read(property.type, offset);
            if (!Number.isFinite(value)) {
              return refuse(
                `vertex ${row + 1} of ${element.count} has a coordinate that is not a finite number`
              );
            }
            vertex.offsets[axis] = offset;
            vertex.values[axis] = value;
          }
          offset += size;
        } else {
          const countSize = PLY_SIZES[property.countType];
          if (offset + countSize > data.length) return short();
          const count = read(property.countType, offset);
          if (count < 0) {
            return refuse(
              `${element.name} ${row + 1} of ${element.count} has a list of negative length`
            );
          }
          offset += countSize + count * PLY_SIZES[property.itemType];
          if (offset > data.length) return short();
        }
      }
      if (isVertex) visit(vertex);
    }
    // Elements after the vertices carry no positions; stop once they are done.
    if (isVertex) return;
  }
}

/** Whether the translator's `line.trim().is_empty()` holds for a line. */
function isBlankLine(
  data: Uint8Array,
  start: number,
  end: number,
  refuse: Refuse
): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    const byte = data[cursor]!;
    if (isAsciiSpace(byte)) continue;
    if (byte < 0x80) return false;
    // Possibly Unicode white space: only the decoded line can say.
    TOKEN.lastIndex = 0;
    return !TOKEN.test(decodeLine(data, start, end, refuse));
  }
  return true;
}

/**
 * An ASCII body holds one element instance per non-blank line, and the
 * translator refuses a line with fewer or more values than its element
 * declares. Elements before the vertices are passed a line at a time, unread.
 */
function walkAsciiPly(
  data: Uint8Array,
  layout: PlyLayout,
  axisOf: readonly number[],
  vertex: PlyVertex,
  refuse: Refuse,
  visit: (vertex: PlyVertex) => void
): void {
  let next = layout.bodyStart;
  for (const element of layout.elements) {
    const isVertex = element === layout.vertex;
    for (let row = 0; row < element.count; row += 1) {
      const where = `${element.name} ${row + 1} of ${element.count}`;
      let start: number;
      let end: number;
      do {
        if (next >= data.length) return refuse(`it ends before ${where}`);
        start = next;
        end = data.indexOf(LINE_FEED, start);
        if (end < 0) end = data.length;
        next = end + 1;
      } while (isBlankLine(data, start, end, refuse));
      if (!isVertex) continue;

      const text = decodeLine(data, start, end, refuse);
      TOKEN.lastIndex = 0;
      const take = (): RegExpExecArray =>
        TOKEN.exec(text) ??
        refuse(`${where} has fewer values than its header declares`);
      for (const [index, property] of element.properties.entries()) {
        if (property.kind === 'list') {
          const length = take()[0];
          const range = PLY_INTEGER_RANGES[property.countType]!;
          const count = RUST_INTEGER.test(length) ? Number(length) : -1;
          if (count < 0 || count > range[1]) {
            return refuse(
              `${where} has a list length it cannot read (${quoted(length)})`
            );
          }
          for (let item = 0; item < count; item += 1) take();
          continue;
        }
        const token = take();
        const axis = axisOf[index]!;
        if (axis < 0) continue;
        vertex.starts[axis] = token.index;
        vertex.ends[axis] = token.index + token[0].length;
        vertex.values[axis] = plyAsciiValue(
          token[0],
          property.type,
          where,
          refuse
        );
      }
      if (TOKEN.exec(text)) {
        return refuse(`${where} has more values than its header declares`);
      }
      vertex.lineStart = start;
      vertex.lineEnd = end;
      vertex.text = text;
      visit(vertex);
    }
    if (isVertex) return;
  }
}

/**
 * One ASCII coordinate as the translator reads it for its declared type: an
 * integer within the type's range, or a number — single precision for a
 * `float`, which is refused when it overflows one.
 */
function plyAsciiValue(
  token: string,
  type: PlyScalar,
  where: string,
  refuse: Refuse
): number {
  const cannotHold = () =>
    refuse(
      `${where} has a coordinate its ${type} type cannot hold (${quoted(token)})`
    );
  const range = PLY_INTEGER_RANGES[type];
  if (range) {
    const value = RUST_INTEGER.test(token) ? Number(token) : NaN;
    return value >= range[0] && value <= range[1] ? value : cannotHold();
  }
  const value = finiteDecimal(token, `${where} has a coordinate`, refuse);
  if (type === 'double') return value;
  const single = Math.fround(value);
  return Number.isFinite(single) ? single : cannotHold();
}

function scalePly(
  data: Uint8Array,
  factor: number,
  budget: UnitlessMeshBudget,
  refuse: Refuse
): Uint8Array {
  const layout = readPlyLayout(data, refuse);
  // No vertex instances: the translator reads no position from this file.
  if (!layout.vertex || !layout.axes) return data;
  assertVertexBudget(layout.vertex.count, budget);

  const properties = layout.axes.map((index) => {
    const property = layout.vertex!.properties[index]!;
    // `readPlyLayout` refuses a list here.
    if (property.kind !== 'scalar') return refuse(UNCONVERTED);
    return property;
  });
  // A `float` stays single precision, as a millimetre file of the same
  // precision would be. An integer cannot hold its value in another unit, so
  // it is declared and written as a double instead.
  const double = properties.map((property) => property.type !== 'float');
  const sizes = properties.map((property) => PLY_SIZES[property.type]);
  // Axes in the order their values are stored, which need not be x, y, z.
  const order = [0, 1, 2].sort((a, b) => layout.axes![a]! - layout.axes![b]!);

  const writer = new BoundedWriter(data.length, budget);
  let copied = 0;
  for (const property of properties
    .filter((candidate) => !isFloatType(candidate.type))
    .sort((a, b) => a.lineStart - b.lineStart)) {
    const text = decodeLine(data, property.lineStart, property.lineEnd, refuse);
    TOKEN.lastIndex = 0;
    TOKEN.exec(text);
    const type = TOKEN.exec(text);
    if (!type) return refuse(UNCONVERTED);
    writer.copy(data, copied, property.lineStart);
    writer.text(
      `${text.slice(0, type.index)}double${text.slice(type.index + type[0].length)}`,
      false
    );
    copied = property.lineEnd;
  }

  const ascii = layout.encoding === 'ascii';
  const littleEndian = layout.encoding === 'binary_little_endian';
  const written = new Extent();
  const scaled = [0, 0, 0];
  walkPlyVertices(data, layout, refuse, (vertex) => {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertex.values[axis]! * factor;
      scaled[axis] = double[axis] ? value : Math.fround(value);
      if (!Number.isFinite(scaled[axis])) throw new Error(OUT_OF_RANGE);
    }
    written.add(scaled);
    if (ascii) {
      writer.copy(data, copied, vertex.lineStart);
      writer.text(
        respell(vertex.text, vertex.starts, vertex.ends, scaled, order),
        vertex.text.length === vertex.lineEnd - vertex.lineStart
      );
      copied = vertex.lineEnd;
      return;
    }
    for (const axis of order) {
      writer.copy(data, copied, vertex.offsets[axis]!);
      writer.float(scaled[axis]!, double[axis]!, littleEndian);
      copied = vertex.offsets[axis]! + sizes[axis]!;
    }
  });
  writer.copy(data, copied, data.length);
  const out = writer.finish();

  // Read the finished file back from its own header: as many vertices as it
  // declares, every position a float type now, at the values just written.
  const check = readPlyLayout(out, refuse);
  const read = new Extent();
  walkPlyVertices(out, check, refuse, (vertex) => read.add(vertex.values));
  if (
    written.count !== layout.vertex.count ||
    check.vertex?.count !== layout.vertex.count ||
    !check.axes?.every((index) => {
      const property = check.vertex!.properties[index]!;
      return property.kind === 'scalar' && isFloatType(property.type);
    }) ||
    !read.matches(written)
  ) {
    return refuse(UNCONVERTED);
  }
  return out;
}
