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
 * Two helpers close that gap without a second parser for either format:
 *
 * - {@link unitlessMeshExtent} reads a file's raw coordinate extent, cheaply
 *   and without the kernel, so the unit prompt can size each choice before
 *   the import runs.
 * - {@link scaleUnitlessMeshFile} rewrites the vertex coordinates of the file
 *   itself into millimetres, so the import runs on exactly the bytes a
 *   millimetre copy of the same part would have.
 *
 * Only vertex positions change. Everything else — faces, normals, texture
 * coordinates, colours, comments, element order — is copied byte for byte.
 */

export type UnitlessMeshFormat = 'obj' | 'ply';

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const LOWER_V = 0x76;

/** Width, depth and height of a file's vertex positions, or null if none. */
export function unitlessMeshExtent(
  format: UnitlessMeshFormat,
  data: Uint8Array
): number[] | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (x: number, y: number, z: number) => {
    const point = [x, y, z];
    for (let axis = 0; axis < 3; axis += 1) {
      const value = point[axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  };
  if (format === 'obj') {
    forEachObjVertexLine(data, (line) => {
      const numbers = objVertexNumbers(line);
      if (numbers) visit(numbers[0], numbers[1], numbers[2]);
    });
  } else {
    const layout = readPlyLayout(data);
    if (!layout) return null;
    walkPlyVertices(data, layout, (point) => {
      visit(point.x, point.y, point.z);
    });
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
  return min.map((low, axis) => max[axis]! - low);
}

/**
 * The file with every vertex position multiplied by `factor`, or null when
 * its positions cannot be rewritten in place — a PLY that stores them as
 * integers, whose scaled values the declared type cannot hold. The caller
 * then reads the file as written and scales the result instead.
 *
 * A file this cannot parse is returned unchanged rather than refused: the
 * translator reads it next, and its refusal names what is wrong.
 */
export function scaleUnitlessMeshFile(
  format: UnitlessMeshFormat,
  data: Uint8Array,
  factor: number
): Uint8Array | null {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new RangeError(`Unit scale must be a positive number: ${factor}.`);
  }
  if (factor === 1) return data;
  return format === 'obj' ? scaleObj(data, factor) : scalePly(data, factor);
}

// ---------------------------------------------------------------------------
// OBJ

/**
 * Calls `visit` with the byte range of every `v` statement (not `vn`, `vt`
 * or `vp`). Lines end at LF or CR, as the translator ends them.
 */
function forEachObjVertexLine(
  data: Uint8Array,
  visit: (line: { start: number; end: number; data: Uint8Array }) => void
): void {
  let index = 0;
  while (index < data.length) {
    let end = index;
    while (
      end < data.length &&
      data[end] !== LINE_FEED &&
      data[end] !== CARRIAGE_RETURN
    ) {
      end += 1;
    }
    let cursor = index;
    while (data[cursor] === SPACE || data[cursor] === TAB) cursor += 1;
    if (
      data[cursor] === LOWER_V &&
      (data[cursor + 1] === SPACE || data[cursor + 1] === TAB)
    ) {
      visit({ start: index, end, data });
    }
    index = end + 1;
  }
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The first three numbers of a `v` statement, or null if it has fewer. */
function objVertexNumbers(line: {
  start: number;
  end: number;
  data: Uint8Array;
}): [number, number, number] | null {
  const tokens = objVertexTokens(line);
  if (!tokens) return null;
  const values = tokens.map((token) => token.value);
  return [values[0]!, values[1]!, values[2]!];
}

interface ObjToken {
  /** Offsets within the line's text. */
  start: number;
  end: number;
  value: number;
}

function objVertexTokens(line: {
  start: number;
  end: number;
  data: Uint8Array;
}): ObjToken[] | null {
  const text = decoder.decode(line.data.subarray(line.start, line.end));
  const pattern = /[^\s]+/g;
  // Skip the `v` keyword.
  if (!pattern.exec(text)) return null;
  const tokens: ObjToken[] = [];
  for (let match = pattern.exec(text); match && tokens.length < 3;) {
    if (match[0].startsWith('#')) break;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return null;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      value
    });
    match = pattern.exec(text);
  }
  return tokens.length === 3 ? tokens : null;
}

function scaleObj(data: Uint8Array, factor: number): Uint8Array {
  const chunks: Uint8Array[] = [];
  let copied = 0;
  let length = 0;
  forEachObjVertexLine(data, (line) => {
    const tokens = objVertexTokens(line);
    if (!tokens) return;
    const text = decoder.decode(data.subarray(line.start, line.end));
    let rewritten = '';
    let cursor = 0;
    for (const token of tokens) {
      const scaled = token.value * factor;
      if (!Number.isFinite(scaled)) {
        throw new Error(
          'This file places a vertex beyond the range a number can hold in the chosen unit.'
        );
      }
      rewritten += text.slice(cursor, token.start) + String(scaled);
      cursor = token.end;
    }
    rewritten += text.slice(cursor);
    const before = data.subarray(copied, line.start);
    const replaced = encoder.encode(rewritten);
    chunks.push(before, replaced);
    length += before.length + replaced.length;
    copied = line.end;
  });
  if (chunks.length === 0) return data;
  chunks.push(data.subarray(copied));
  length += data.length - copied;
  return concatenate(chunks, length);
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

type PlyProperty =
  | { kind: 'scalar'; name: string; type: PlyScalar }
  | { kind: 'list'; name: string; countType: PlyScalar; itemType: PlyScalar };

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

interface PlyLayout {
  encoding: 'ascii' | 'binary_little_endian' | 'binary_big_endian';
  /** Byte offset of the first body byte, just past `end_header`'s line. */
  bodyStart: number;
  elements: PlyElement[];
}

/** The header, or null if this is not a PLY header this reader follows. */
function readPlyLayout(data: Uint8Array): PlyLayout | null {
  // Headers are short; a generous window still bounds the work on a file
  // that never ends its header.
  const window = decoder.decode(data.subarray(0, Math.min(data.length, 65536)));
  const marker = /end_header[ \t]*\r?\n/.exec(window);
  if (!marker || !window.startsWith('ply')) return null;
  const header = window.slice(0, marker.index);
  const bodyStart = encoder.encode(
    window.slice(0, marker.index + marker[0].length)
  ).length;
  let encoding: PlyLayout['encoding'] | null = null;
  const elements: PlyElement[] = [];
  for (const raw of header.split(/\r?\n/)) {
    const words = raw.trim().split(/\s+/);
    if (words[0] === 'format') {
      const value = words[1];
      if (
        value === 'ascii' ||
        value === 'binary_little_endian' ||
        value === 'binary_big_endian'
      ) {
        encoding = value;
      } else {
        return null;
      }
    } else if (words[0] === 'element') {
      const count = Number(words[2]);
      if (!words[1] || !Number.isSafeInteger(count) || count < 0) return null;
      elements.push({ name: words[1], count, properties: [] });
    } else if (words[0] === 'property') {
      const element = elements.at(-1);
      if (!element) return null;
      if (words[1] === 'list') {
        const countType = PLY_TYPE_ALIASES[words[2] ?? ''];
        const itemType = PLY_TYPE_ALIASES[words[3] ?? ''];
        if (!countType || !itemType || !words[4]) return null;
        element.properties.push({
          kind: 'list',
          name: words[4],
          countType,
          itemType
        });
      } else {
        const type = PLY_TYPE_ALIASES[words[1] ?? ''];
        if (!type || !words[2]) return null;
        element.properties.push({ kind: 'scalar', name: words[2], type });
      }
    }
  }
  return encoding ? { encoding, bodyStart, elements } : null;
}

interface PlyPositionSlot {
  /** Binary: byte offset of the value. ASCII: token start and end offsets. */
  offset: number;
  end: number;
  type: PlyScalar;
}

interface PlyVertex {
  x: number;
  y: number;
  z: number;
  slots: [PlyPositionSlot, PlyPositionSlot, PlyPositionSlot];
}

/**
 * Walks every element of the body in order and calls `visit` with each
 * vertex's position and where it is stored. Returns false when the body is
 * not laid out as the header says (the translator will refuse it), or the
 * vertex element has no scalar x, y and z.
 */
function walkPlyVertices(
  data: Uint8Array,
  layout: PlyLayout,
  visit: (vertex: PlyVertex) => void
): boolean {
  const vertexElement = layout.elements.find(
    (element) => element.name === 'vertex'
  );
  if (!vertexElement) return false;
  const axisIndex = ['x', 'y', 'z'].map((axis) =>
    vertexElement.properties.findIndex(
      (property) => property.kind === 'scalar' && property.name === axis
    )
  );
  if (axisIndex.some((index) => index < 0)) return false;
  return layout.encoding === 'ascii'
    ? walkAsciiPly(data, layout, vertexElement, axisIndex, visit)
    : walkBinaryPly(
        data,
        layout,
        vertexElement,
        axisIndex,
        layout.encoding === 'binary_little_endian',
        visit
      );
}

function walkBinaryPly(
  data: Uint8Array,
  layout: PlyLayout,
  vertexElement: PlyElement,
  axisIndex: number[],
  littleEndian: boolean,
  visit: (vertex: PlyVertex) => void
): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
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
    const isVertex = element === vertexElement;
    for (let row = 0; row < element.count; row += 1) {
      const slots: PlyPositionSlot[] = [];
      const values: number[] = [];
      for (const [index, property] of element.properties.entries()) {
        if (property.kind === 'scalar') {
          const size = PLY_SIZES[property.type];
          if (offset + size > data.length) return false;
          const axis = isVertex ? axisIndex.indexOf(index) : -1;
          if (axis >= 0) {
            slots[axis] = { offset, end: offset + size, type: property.type };
            values[axis] = read(property.type, offset);
          }
          offset += size;
        } else {
          const countSize = PLY_SIZES[property.countType];
          if (offset + countSize > data.length) return false;
          const count = read(property.countType, offset);
          offset += countSize + count * PLY_SIZES[property.itemType];
          if (count < 0 || offset > data.length) return false;
        }
      }
      if (isVertex) {
        visit({
          x: values[0]!,
          y: values[1]!,
          z: values[2]!,
          slots: slots as PlyVertex['slots']
        });
      }
    }
    // Elements after the vertices carry no positions; stop once they are done.
    if (isVertex) return true;
  }
  return true;
}

function walkAsciiPly(
  data: Uint8Array,
  layout: PlyLayout,
  vertexElement: PlyElement,
  axisIndex: number[],
  visit: (vertex: PlyVertex) => void
): boolean {
  let offset = layout.bodyStart;
  const nextToken = (): { start: number; end: number } | null => {
    while (offset < data.length && isAsciiBlank(data[offset]!)) offset += 1;
    if (offset >= data.length) return null;
    const start = offset;
    while (offset < data.length && !isAsciiBlank(data[offset]!)) offset += 1;
    return { start, end: offset };
  };
  const numberAt = (token: { start: number; end: number }) =>
    Number(decoder.decode(data.subarray(token.start, token.end)));
  for (const element of layout.elements) {
    const isVertex = element === vertexElement;
    for (let row = 0; row < element.count; row += 1) {
      const slots: PlyPositionSlot[] = [];
      const values: number[] = [];
      for (const [index, property] of element.properties.entries()) {
        if (property.kind === 'scalar') {
          const token = nextToken();
          if (!token) return false;
          const axis = isVertex ? axisIndex.indexOf(index) : -1;
          if (axis >= 0) {
            const value = numberAt(token);
            if (!Number.isFinite(value)) return false;
            slots[axis] = {
              ...token,
              offset: token.start,
              type: property.type
            };
            values[axis] = value;
          }
        } else {
          const countToken = nextToken();
          if (!countToken) return false;
          const count = numberAt(countToken);
          if (!Number.isSafeInteger(count) || count < 0) return false;
          for (let item = 0; item < count; item += 1) {
            if (!nextToken()) return false;
          }
        }
      }
      if (isVertex) {
        visit({
          x: values[0]!,
          y: values[1]!,
          z: values[2]!,
          slots: slots as PlyVertex['slots']
        });
      }
    }
    if (isVertex) return true;
  }
  return true;
}

function isAsciiBlank(byte: number): boolean {
  return (
    byte === SPACE ||
    byte === TAB ||
    byte === LINE_FEED ||
    byte === CARRIAGE_RETURN
  );
}

function isFloatType(type: PlyScalar): boolean {
  return type === 'float' || type === 'double';
}

function scalePly(data: Uint8Array, factor: number): Uint8Array | null {
  const layout = readPlyLayout(data);
  if (!layout) return data;
  const vertexElement = layout.elements.find(
    (element) => element.name === 'vertex'
  );
  const positionTypes = ['x', 'y', 'z'].map((axis) => {
    const property = vertexElement?.properties.find(
      (candidate) => candidate.kind === 'scalar' && candidate.name === axis
    );
    return property?.kind === 'scalar' ? property.type : null;
  });
  // No positions to find: the translator refuses the file by name next.
  if (positionTypes.some((type) => type === null)) return data;
  if (positionTypes.some((type) => !isFloatType(type!))) return null;
  const scaledValue = (value: number, type: PlyScalar) => {
    const scaled =
      type === 'float' ? Math.fround(value * factor) : value * factor;
    if (!Number.isFinite(scaled)) {
      throw new Error(
        'This file places a vertex beyond the range a number can hold in the chosen unit.'
      );
    }
    return scaled;
  };
  if (layout.encoding !== 'ascii') {
    const out = data.slice();
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const littleEndian = layout.encoding === 'binary_little_endian';
    const walked = walkPlyVertices(data, layout, (vertex) => {
      const values = [vertex.x, vertex.y, vertex.z];
      vertex.slots.forEach((slot, axis) => {
        const scaled = scaledValue(values[axis]!, slot.type);
        if (slot.type === 'float') {
          view.setFloat32(slot.offset, scaled, littleEndian);
        } else {
          view.setFloat64(slot.offset, scaled, littleEndian);
        }
      });
    });
    return walked ? out : data;
  }
  const chunks: Uint8Array[] = [];
  let copied = 0;
  let length = 0;
  const walked = walkPlyVertices(data, layout, (vertex) => {
    const values = [vertex.x, vertex.y, vertex.z];
    vertex.slots.forEach((slot, axis) => {
      const before = data.subarray(copied, slot.offset);
      const replaced = encoder.encode(
        String(scaledValue(values[axis]!, slot.type))
      );
      chunks.push(before, replaced);
      length += before.length + replaced.length;
      copied = slot.end;
    });
  });
  if (!walked) return data;
  chunks.push(data.subarray(copied));
  length += data.length - copied;
  return concatenate(chunks, length);
}

function concatenate(chunks: readonly Uint8Array[], length: number) {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
