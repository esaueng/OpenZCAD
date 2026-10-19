import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodePng } from './pngEncode';

interface Chunk {
  type: string;
  data: Uint8Array;
  crc: number;
}

function chunks(png: Uint8Array): Chunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    out.push({
      type,
      data: png.subarray(offset + 8, offset + 8 + length),
      crc: view.getUint32(offset + 8 + length)
    });
    offset += 12 + length;
  }
  return out;
}

/** Undo the Sub filter the encoder writes on every row. */
function decode(png: Uint8Array) {
  const parts = chunks(png);
  const header = new DataView(parts[0]!.data.buffer, parts[0]!.data.byteOffset);
  const width = header.getUint32(0);
  const height = header.getUint32(4);
  const raw = inflateSync(parts.find((part) => part.type === 'IDAT')!.data);
  const stride = width * 4;
  const rgba = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? rgba[y * stride + x - 4]! : 0;
      rgba[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + left) & 0xff;
    }
  }
  return { width, height, rgba, parts };
}

/** CRC-32 over a chunk's type and data, written independently of the encoder. */
function crc(type: string, data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of [...type]
    .map((ch) => ch.charCodeAt(0))
    .concat([...data])) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

describe('encodePng', () => {
  it('writes the requested size as 8-bit RGBA with valid chunks and no metadata', async () => {
    const width = 7;
    const height = 3;
    const rgba = new Uint8Array(width * height * 4).map(
      (_, i) => (i * 37) & 0xff
    );
    const png = await encodePng(rgba, width, height);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const decoded = decode(png);
    expect(decoded.parts.map((part) => part.type)).toEqual([
      'IHDR',
      'IDAT',
      'IEND'
    ]);
    for (const part of decoded.parts) {
      expect(part.crc).toBe(crc(part.type, part.data));
    }
    const ihdr = decoded.parts[0]!.data;
    expect([...ihdr.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect([...decoded.rgba]).toEqual([...rgba]);
  });

  it('keeps straight alpha exact, transparent and faint pixels alike', async () => {
    // A transparent pixel, a faint shadow, and an opaque body pixel: a canvas
    // round trip would premultiply the faint one and lose its colour.
    const rgba = new Uint8Array([0, 0, 0, 0, 40, 50, 60, 3, 200, 100, 50, 255]);
    const { rgba: back } = decode(await encodePng(rgba, 3, 1));
    expect([...back]).toEqual([...rgba]);
  });

  it('refuses a size that does not match the pixels', async () => {
    await expect(encodePng(new Uint8Array(16), 3, 1)).rejects.toThrow(
      /Expected 12 bytes/
    );
    await expect(encodePng(new Uint8Array(0), 0, 1)).rejects.toThrow(
      /positive whole size/
    );
  });
});
