/**
 * A minimal PNG writer for viewport image exports: 8-bit RGBA, one IDAT, no
 * ancillary chunks. Writing the file here rather than through a canvas keeps
 * straight alpha exact (a 2D canvas stores premultiplied colour, so faint
 * shadow pixels on a transparent background lose their colour on the way
 * through) and guarantees the file carries no metadata at all.
 */

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  // 'deflate' is the zlib-wrapped stream (RFC 1950) PNG's IDAT requires.
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode top-down, straight-alpha RGBA pixels as a PNG. Every scanline uses
 * the Sub filter: a rendered image is mostly flat runs, which Sub turns into
 * zeros that deflate well, at a fraction of the cost of choosing per row.
 */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new Error(
      `A PNG needs a positive whole size, got ${width}×${height}.`
    );
  }
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(
      `Expected ${stride * height} bytes of RGBA for ${width}×${height}, got ${rgba.length}.`
    );
  }
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    const out = y * (stride + 1);
    raw[out] = 1; // Sub
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? rgba[row + x - 4]! : 0;
      raw[out + 1 + x] = (rgba[row + x]! - left) & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  // compression, filter and interlace methods stay 0
  const parts = [
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', await zlibDeflate(raw)),
    chunk('IEND', new Uint8Array(0))
  ];
  const png = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
