/**
 * What a 3MF package asks for, read from the package itself.
 *
 * A 3MF's `<model>` element carries a `unit` attribute and its `<build>`
 * section says which of the `<resources>` objects are actually placed, how
 * many times, and where. The pinned translator reads neither: measured on the
 * pin, a box marked `meter` imports with the same coordinates as one marked
 * `millimeter`; an `<item>` transform is dropped, so a doubled box imports at
 * original size; an object placed twice imports once; and an object never
 * placed at all imports anyway. Every one of those is geometry silently
 * different from what the file states, which is exactly the guessing the
 * adapter refuses everywhere else — so the declaration, the placements and
 * their matrices are read here and the import honours them.
 *
 * Reading them means opening the Zip package, which is why there is a small
 * Zip reader here. The relationship part is read in its first 64 KB; the 3D
 * model part is streamed and scanned for its structural tags without ever
 * holding more than one chunk, under a hard ceiling, so a hostile package
 * cannot expand into memory through this path.
 */

/** The 3MF core specification's length units, in millimetres. */
const UNIT_MILLIMETRES: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000
};

/**
 * The 3MF core specification's default when `<model>` omits `unit`.
 */
export const THREE_MF_DEFAULT_UNIT = 'millimeter';

export interface ThreeMfUnit {
  /** The unit as the file spells it. */
  readonly name: string;
  /** How many millimetres one of those units is. */
  readonly millimetres: number;
}

/** One `<item>`: which object the build places, and where it puts it. */
export interface ThreeMfPlacement {
  /**
   * Index of the placed object among the package's mesh objects, in
   * `<resources>` document order — which is the order the translator returns
   * its solids in. Verified on the pin: reversing two `<object>` elements
   * reverses the two solids.
   */
  readonly objectIndex: number;
  /** The object id the item named, for messages. */
  readonly objectId: string;
  /**
   * The item's `transform`, as the 3MF core format's twelve numbers
   * (`m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32`, applied to a row
   * vector), or null when the item declares none.
   */
  readonly transform: readonly number[] | null;
}

export interface ThreeMfPackage {
  readonly unit: ThreeMfUnit;
  /** How many `<object>` resources carry a mesh, in document order. */
  readonly meshObjectCount: number;
  /** What `<build>` places, in build order. One entry per `<item>`. */
  readonly placements: readonly ThreeMfPlacement[];
}

/** The relationship part is a handful of elements in every real package. */
const RELATIONSHIP_BYTES = 64 * 1024;
/**
 * The ceiling on the 3D model part the scan will read. The document's own
 * limit is 200,000 triangles, whose XML — a `<vertex>` or `<triangle>` element
 * per entity, well under a hundred bytes each — is tens of megabytes. This
 * ceiling is an order of magnitude above that, so no file the import would
 * accept meets it, and a package that inflates past it is refused rather than
 * read.
 */
const MODEL_SCAN_BYTES = 256 * 1024 * 1024;
const MODEL_RELATIONSHIP_TYPE =
  'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';
const DEFAULT_MODEL_PART = '3D/3dmodel.model';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;
const STORED = 0;
const DEFLATED = 8;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly compressedBytes: number;
  readonly localHeaderOffset: number;
}

/** The package itself could not be opened far enough to read anything. */
function refuse(detail: string): Error {
  return new Error(`This 3MF package could not be read: ${detail}.`);
}

/** One `<object>` resource, as the scan sees it. */
interface ScannedObject {
  readonly id: string;
  hasMesh: boolean;
  hasComponents: boolean;
}

interface ScannedItem {
  readonly objectId: string | null;
  readonly transform: string | null;
  readonly path: string | null;
}

interface ScannedModel {
  unit: string | null;
  readonly objects: ScannedObject[];
  readonly items: ScannedItem[];
  sawModel: boolean;
  sawBuild: boolean;
}

/**
 * The unit, the mesh objects and the build placements a 3MF package declares.
 *
 * Refuses rather than assuming whenever the package cannot be read, names a
 * unit the specification does not define, or asks for something the import
 * cannot carry out faithfully: a guess here would publish geometry at the
 * wrong size, in the wrong place, or in the wrong number, with nothing on
 * screen to say so.
 */
export async function readThreeMfPackage(
  data: Uint8Array
): Promise<ThreeMfPackage> {
  const entries = readZipDirectory(data);
  const modelPart = await resolveModelPart(data, entries);
  return interpret(await scanModelPart(data, modelPart));
}

function interpret(scanned: ScannedModel): ThreeMfPackage {
  // A 3MF that omits the attribute is millimetres by specification, which is
  // a declaration rather than an assumption.
  const name = (scanned.unit ?? THREE_MF_DEFAULT_UNIT).trim();
  const millimetres = UNIT_MILLIMETRES[name];
  if (millimetres === undefined) {
    throw new Error(
      `This 3MF declares unit "${name}", which the 3MF core format does not ` +
        'define, so the import cannot tell what its coordinates mean. ' +
        'Re-export it in millimetres, inches, or another declared 3MF unit.'
    );
  }

  const composed = scanned.objects.find((object) => object.hasComponents);
  if (composed) {
    // The pinned translator refuses such a package outright — measured, with
    // "invalid topology for export: mesh has no triangles", which names the
    // wrong cause. Refuse it by what is actually there.
    throw new Error(
      `This 3MF builds object "${composed.id}" out of other objects ` +
        '(<components>), and the import reads only objects that carry their ' +
        'own mesh. Re-export it with the geometry flattened into each object.'
    );
  }

  const meshObjects = scanned.objects.filter((object) => object.hasMesh);
  const indexById = new Map(
    meshObjects.map((object, index) => [object.id, index])
  );
  const placements: ThreeMfPlacement[] = [];
  for (const item of scanned.items) {
    if (item.path !== null) {
      throw new Error(
        `This 3MF places an object from another model part ("${item.path}"), ` +
          'which the import does not follow. Re-export it as a single model ' +
          'part.'
      );
    }
    if (item.objectId === null) {
      throw refuse('one of its <build> items names no object');
    }
    const objectIndex = indexById.get(item.objectId);
    if (objectIndex === undefined) {
      throw new Error(
        `This 3MF's build places object "${item.objectId}", which its ` +
          'resources do not define as a mesh. The package is inconsistent, ' +
          'so the import refused it rather than leaving the object out.'
      );
    }
    placements.push({
      objectIndex,
      objectId: item.objectId,
      transform: item.transform === null ? null : parseTransform(item)
    });
  }
  if (placements.length === 0) {
    throw new Error(
      scanned.sawBuild
        ? 'This 3MF’s <build> section places no objects, so the file ' +
            'asks for no geometry. Re-export it with the parts placed on the ' +
            'build plate.'
        : 'This 3MF has no <build> section, so it states nothing about which ' +
            'of its objects to place. Re-export it from a tool that writes one.'
    );
  }
  return {
    unit: { name, millimetres },
    meshObjectCount: meshObjects.length,
    placements
  };
}

/**
 * The twelve numbers of an `<item transform>`, checked.
 *
 * A matrix that is not twelve finite numbers, or that collapses the object
 * onto a plane, is refused: applying it would publish geometry the file did
 * not ask for, and ignoring it would publish geometry at the wrong size.
 */
function parseTransform(item: ScannedItem): readonly number[] {
  const values = (item.transform ?? '')
    .trim()
    .split(/\s+/)
    .map((part) => Number(part));
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(
      `This 3MF places object "${item.objectId}" with a transform that is ` +
        'not the twelve numbers the format defines, so the import cannot ' +
        'tell where the object goes.'
    );
  }
  if (Math.abs(transformDeterminant(values)) < 1e-12) {
    throw new Error(
      `This 3MF places object "${item.objectId}" with a transform that ` +
        'collapses it to no volume, so there is nothing to import.'
    );
  }
  return values;
}

/** The determinant of the 3x3 part of a 3MF item transform. */
export function transformDeterminant(t: readonly number[]): number {
  return (
    t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) -
    t[1]! * (t[3]! * t[8]! - t[5]! * t[6]!) +
    t[2]! * (t[3]! * t[7]! - t[4]! * t[6]!)
  );
}

/**
 * A point through a 3MF item transform.
 *
 * The format's twelve numbers are the first three columns of a 4x4 matrix
 * applied to a **row** vector, so the last three are the translation.
 */
export function applyThreeMfTransform(
  t: readonly number[],
  x: number,
  y: number,
  z: number
): [number, number, number] {
  return [
    x * t[0]! + y * t[3]! + z * t[6]! + t[9]!,
    x * t[1]! + y * t[4]! + z * t[7]! + t[10]!,
    x * t[2]! + y * t[5]! + z * t[8]! + t[11]!
  ];
}

async function resolveModelPart(
  data: Uint8Array,
  entries: readonly ZipEntry[]
): Promise<ZipEntry> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const relationships = byName.get('_rels/.rels');
  if (relationships) {
    const text = await readEntryPrefix(data, relationships, RELATIONSHIP_BYTES);
    for (const element of text.matchAll(/<Relationship\b[^>]*>/g)) {
      const type = attribute(element[0], 'Type');
      const target = attribute(element[0], 'Target');
      if (type === MODEL_RELATIONSHIP_TYPE && target) {
        const entry = byName.get(target.replace(/^\//, ''));
        if (entry) {
          return entry;
        }
      }
    }
  }
  const fallback =
    byName.get(DEFAULT_MODEL_PART) ??
    entries.find((entry) => entry.name.toLowerCase().endsWith('.model'));
  if (!fallback) {
    throw refuse('it holds no 3D model part');
  }
  return fallback;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? null;
}

const STRUCTURAL_TAG =
  /<(\/?)(model|resources|build|object|components|mesh|item)\b([^>]*)>/g;

/**
 * The structural tags of the 3D model part, without holding the part.
 *
 * `<build>` is the last element of the model, after every vertex and triangle
 * of every object, so reading it means reading the whole part — and the mesh
 * is nearly all of it. The part is therefore streamed: each chunk is scanned
 * for the handful of elements that matter and then dropped, so the scan holds
 * one chunk plus the few hundred bytes of structure it found.
 */
async function scanModelPart(
  data: Uint8Array,
  entry: ZipEntry
): Promise<ScannedModel> {
  const model: ScannedModel = {
    unit: null,
    objects: [],
    items: [],
    sawModel: false,
    sawBuild: false
  };
  const decoder = new TextDecoder();
  let carry = '';
  let inResources = false;
  let inBuild = false;
  let current: ScannedObject | null = null;

  const consume = (text: string, final: boolean): void => {
    const combined = carry + text;
    // A tag can straddle a chunk boundary, so only the text up to the last
    // closed tag is scanned and the remainder leads the next chunk.
    const end = final ? combined.length : combined.lastIndexOf('>') + 1;
    if (end <= 0) {
      carry = combined;
      return;
    }
    const scannable = combined.slice(0, end);
    carry = combined.slice(end);
    for (const match of scannable.matchAll(STRUCTURAL_TAG)) {
      const closing = match[1] === '/';
      const name = match[2]!;
      const selfClosing = (match[3] ?? '').trimEnd().endsWith('/');
      if (closing) {
        if (name === 'resources') {
          inResources = false;
        } else if (name === 'build') {
          inBuild = false;
        } else if (name === 'object' && current) {
          model.objects.push(current);
          current = null;
        }
        continue;
      }
      switch (name) {
        case 'model':
          model.sawModel = true;
          model.unit ??= attribute(match[0], 'unit');
          break;
        case 'resources':
          inResources = !selfClosing;
          break;
        case 'build':
          model.sawBuild = true;
          inBuild = !selfClosing;
          break;
        case 'object':
          if (inResources) {
            const object: ScannedObject = {
              id: attribute(match[0], 'id') ?? '',
              hasMesh: false,
              hasComponents: false
            };
            if (selfClosing) {
              model.objects.push(object);
            } else {
              current = object;
            }
          }
          break;
        case 'mesh':
          if (current) {
            current.hasMesh = true;
          }
          break;
        case 'components':
          if (current) {
            current.hasComponents = true;
          }
          break;
        default:
          if (inBuild) {
            model.items.push({
              objectId: attribute(match[0], 'objectid'),
              transform: attribute(match[0], 'transform'),
              path: attribute(match[0], 'path')
            });
          }
          break;
      }
    }
  };

  for await (const chunk of entryChunks(data, entry, MODEL_SCAN_BYTES)) {
    consume(decoder.decode(chunk, { stream: true }), false);
  }
  consume(decoder.decode(), true);
  if (current) {
    model.objects.push(current);
  }
  if (!model.sawModel) {
    throw refuse('its 3D model part holds no <model> element');
  }
  return model;
}

function readZipDirectory(data: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const end = findEndOfCentralDirectory(view);
  if (end === null) {
    throw refuse('it is not a Zip package');
  }
  const entryCount = view.getUint16(end + 10, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    entryCount === ZIP64_SENTINEL_16 ||
    directoryOffset === ZIP64_SENTINEL_32
  ) {
    throw refuse('it is a Zip64 package, which this reader does not open');
  }
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > data.byteLength ||
      view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE
    ) {
      throw refuse('its Zip directory is truncated');
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      name: new TextDecoder().decode(
        data.subarray(cursor + 46, cursor + 46 + nameLength)
      ),
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      compressedBytes: view.getUint32(cursor + 20, true),
      localHeaderOffset: view.getUint32(cursor + 42, true)
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(view: DataView): number | null {
  // The end record is last, unless the archive carries a comment — at most
  // 64 KB of one.
  const first = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  return null;
}

async function readEntryPrefix(
  data: Uint8Array,
  entry: ZipEntry,
  maxBytes: number
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of entryChunks(data, entry, maxBytes, true)) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/** Where an entry's compressed body starts, and that it can be read at all. */
function entryBody(data: Uint8Array, entry: ZipEntry): Uint8Array {
  if ((entry.flags & 1) !== 0) {
    throw refuse(`its part "${entry.name}" is encrypted`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = entry.localHeaderOffset;
  if (
    header + 30 > data.byteLength ||
    view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE
  ) {
    throw refuse(`its part "${entry.name}" has no readable Zip header`);
  }
  const start =
    header +
    30 +
    view.getUint16(header + 26, true) +
    view.getUint16(header + 28, true);
  return data.subarray(start, start + entry.compressedBytes);
}

/**
 * A Zip entry's bytes, chunk by chunk, and never more than `maxBytes` of them.
 *
 * `truncate` is how the relationship part is read: it wants a prefix and the
 * rest is uninteresting, so the stream stops once it has enough. The model
 * part instead needs all of itself — its `<build>` section is at the very end —
 * so it refuses at the ceiling rather than reading a prefix and drawing
 * conclusions from half a file.
 */
async function* entryChunks(
  data: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
  truncate = false
): AsyncGenerator<Uint8Array> {
  const body = entryBody(data, entry);
  if (entry.method === STORED) {
    if (body.byteLength > maxBytes) {
      if (!truncate) {
        throw refuse(
          `its part "${entry.name}" is larger than the ${maxBytes} bytes the import reads`
        );
      }
      yield body.subarray(0, maxBytes);
      return;
    }
    yield body;
    return;
  }
  if (entry.method !== DEFLATED) {
    throw refuse(
      `its part "${entry.name}" uses Zip compression method ${entry.method}`
    );
  }
  // `BufferSource`, because that is what the compression streams accept. A
  // copy onto a plain ArrayBuffer: a view onto a possibly-shared buffer is not
  // one.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(body));
      controller.close();
    }
  });
  const reader = source
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  let total = 0;
  try {
    for (;;) {
      let chunk: Uint8Array;
      try {
        const { done, value } = await reader.read();
        if (done || !value) {
          break;
        }
        chunk = value;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        throw refuse(`a part could not be decompressed: ${detail}`);
      }
      if (total + chunk.byteLength > maxBytes) {
        if (!truncate) {
          throw refuse(
            `its part "${entry.name}" expands past the ${maxBytes} bytes the import reads`
          );
        }
        yield chunk.subarray(0, maxBytes - total);
        return;
      }
      total += chunk.byteLength;
      yield chunk;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
