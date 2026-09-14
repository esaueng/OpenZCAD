/**
 * The length unit a 3MF package declares, read from the package itself.
 *
 * A 3MF's `<model>` element carries a `unit` attribute, and unlike STL the
 * format therefore states what its numbers mean. The pinned translator ignores
 * it — measured on the pin, a box marked `meter` imports with the same
 * coordinates as one marked `millimeter` — so a file authored in inches would
 * land 25.4x too small unless the attribute is read here. Silently adopting
 * the wrong scale is exactly the guessed geometry the adapter refuses
 * everywhere else, so this module reads the declaration and the import either
 * honours it or refuses by name.
 *
 * Reading it means opening the Zip package, which is why there is a small Zip
 * reader here: only the relationship part and the first bytes of the model
 * part are ever decompressed, both capped, so a hostile package cannot expand
 * into memory through this path.
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

/** Everything past this in the model part is mesh data, not the header. */
const MODEL_HEADER_BYTES = 64 * 1024;
/** The relationship part is a handful of elements in every real package. */
const RELATIONSHIP_BYTES = 64 * 1024;
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

/**
 * The unit a 3MF package declares.
 *
 * Refuses rather than assuming millimetres whenever the package cannot be
 * read or names a unit the specification does not define: an import that
 * guessed here would publish geometry at the wrong size with nothing on
 * screen to say so.
 */
export async function readThreeMfUnit(data: Uint8Array): Promise<ThreeMfUnit> {
  const entries = readZipDirectory(data);
  const modelPart = await resolveModelPart(data, entries);
  const header = await readEntryPrefix(data, modelPart, MODEL_HEADER_BYTES);
  const tag = /<model\b[^>]*>/.exec(header);
  if (!tag) {
    throw refuse('its 3D model part has no <model> element in the first 64 KB');
  }
  const declared = /\bunit\s*=\s*"([^"]*)"|\bunit\s*=\s*'([^']*)'/.exec(
    tag[0]
  );
  // A 3MF that omits the attribute is millimetres by specification, which is
  // a declaration rather than an assumption.
  const name = (declared?.[1] ?? declared?.[2] ?? THREE_MF_DEFAULT_UNIT).trim();
  const millimetres = UNIT_MILLIMETRES[name];
  if (millimetres === undefined) {
    throw new Error(
      `This 3MF declares unit "${name}", which the 3MF core format does not ` +
        'define, so the import cannot tell what its coordinates mean. ' +
        'Re-export it in millimetres, inches, or another declared 3MF unit.'
    );
  }
  return { name, millimetres };
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
  const body = data.subarray(start, start + entry.compressedBytes);
  if (entry.method === STORED) {
    return new TextDecoder().decode(body.subarray(0, maxBytes));
  }
  if (entry.method !== DEFLATED) {
    throw refuse(
      `its part "${entry.name}" uses Zip compression method ${entry.method}`
    );
  }
  return new TextDecoder().decode(await inflatePrefix(body, maxBytes));
}

/**
 * The first `maxBytes` of a raw-deflate part, and no more of it.
 *
 * The reader is cancelled as soon as it has enough, so a part that would
 * expand to gigabytes costs only the bytes actually asked for.
 */
async function inflatePrefix(
  body: Uint8Array,
  maxBytes: number
): Promise<Uint8Array> {
  // `BufferSource`, because that is what the compression streams accept.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // A copy onto a plain ArrayBuffer: the streams take a `BufferSource`,
      // and a view onto a possibly-shared buffer is not one.
      controller.enqueue(new Uint8Array(body));
      controller.close();
    }
  });
  const reader = source
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    throw refuse(`a part could not be decompressed: ${detail}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.byteLength) {
      break;
    }
    out.set(chunk.subarray(0, out.byteLength - offset), offset);
    offset += chunk.byteLength;
  }
  return out;
}
