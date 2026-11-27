import { Buffer } from 'node:buffer';
import { deflateSync, inflateSync } from 'node:zlib';

// App Store Connect rejects an app icon that has an alpha channel, even a
// fully opaque one (ITMS-90717). The renderer always writes RGBA, so this
// rewrites an 8-bit, non-interlaced RGBA PNG as RGB. It refuses any pixel
// that is not fully opaque instead of flattening it onto a guessed colour.

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const RGBA = 6;
const RGB = 2;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function readPngChunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file.');
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** The PNG colour type: 2 is RGB, 6 is RGBA. */
export function pngColorType(png) {
  const header = readPngChunks(png).find((entry) => entry.type === 'IHDR');
  if (!header) throw new Error('PNG has no IHDR chunk.');
  return header.data[9];
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function removePngAlpha(png) {
  const chunks = readPngChunks(png);
  const header = chunks.find((entry) => entry.type === 'IHDR');
  if (!header) throw new Error('PNG has no IHDR chunk.');
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const [bitDepth, colorType, , , interlace] = header.data.subarray(8, 13);
  if (colorType === RGB) return png;
  if (bitDepth !== 8 || colorType !== RGBA || interlace !== 0) {
    throw new Error('Only 8-bit, non-interlaced RGBA PNGs are supported.');
  }
  const raw = inflateSync(
    Buffer.concat(
      chunks.filter((entry) => entry.type === 'IDAT').map((entry) => entry.data)
    )
  );
  const stride = width * 4;
  if (raw.length !== height * (stride + 1))
    throw new Error('PNG image data is truncated.');
  const previous = Buffer.alloc(stride);
  const row = Buffer.alloc(stride);
  const output = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[start + 1 + x];
      const left = x >= 4 ? row[x - 4] : 0;
      const up = previous[x];
      const upLeft = x >= 4 ? previous[x - 4] : 0;
      let predicted;
      if (filter === 0) predicted = 0;
      else if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) predicted = paeth(left, up, upLeft);
      else throw new Error(`Unknown PNG filter ${filter}.`);
      row[x] = (value + predicted) & 0xff;
    }
    const target = y * (width * 3 + 1);
    output[target] = 0;
    for (let x = 0; x < width; x += 1) {
      if (row[x * 4 + 3] !== 255) {
        throw new Error(
          `Pixel ${x},${y} is not fully opaque; the icon must have no transparency.`
        );
      }
      row.copy(output, target + 1 + x * 3, x * 4, x * 4 + 3);
    }
    row.copy(previous);
  }
  const newHeader = Buffer.from(header.data);
  newHeader[9] = RGB;
  // Colour-space chunks (sRGB, gAMA, iCCP, pHYs) still apply to RGB data;
  // tRNS would reintroduce transparency, and text or time chunks change the
  // bytes on every render.
  const kept = chunks.filter((entry) =>
    ['sRGB', 'gAMA', 'iCCP', 'cHRM', 'pHYs'].includes(entry.type)
  );
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', newHeader),
    ...kept.map((entry) => chunk(entry.type, entry.data)),
    chunk('IDAT', deflateSync(output, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
