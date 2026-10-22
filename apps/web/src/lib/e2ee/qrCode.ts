/**
 * A small QR code encoder (ISO/IEC 18004) for the device-approval scan code,
 * so the scan form needs no new dependency. It covers what that code needs
 * and a little more: alphanumeric and byte mode, error correction level M,
 * versions 1–6 (up to 106 bytes), with the standard mask selection.
 */

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

interface VersionSpec {
  /** Error-correction codewords per block. */
  readonly ecPerBlock: number;
  /** Data codewords of each block. */
  readonly blocks: readonly number[];
  readonly alignment: readonly number[];
}

/** Level M only. */
const VERSIONS: Readonly<Record<number, VersionSpec>> = {
  1: { ecPerBlock: 10, blocks: [16], alignment: [] },
  2: { ecPerBlock: 16, blocks: [28], alignment: [6, 18] },
  3: { ecPerBlock: 26, blocks: [44], alignment: [6, 22] },
  4: { ecPerBlock: 18, blocks: [32, 32], alignment: [6, 26] },
  5: { ecPerBlock: 24, blocks: [43, 43], alignment: [6, 30] },
  6: { ecPerBlock: 16, blocks: [27, 27, 27, 27], alignment: [6, 34] }
};

// --- GF(256) Reed–Solomon -------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
}

function multiply(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** Coefficients of ∏(x − αⁱ), highest degree first, leading 1 omitted. */
function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ multiply(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** The error-correction codewords for one block of data codewords. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
  const gen = generator(degree);
  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] = remainder[i]! ^ multiply(gen[i]!, factor);
    }
  }
  return remainder;
}

// --- Data codewords -------------------------------------------------------

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
}

function isAlphanumeric(text: string): boolean {
  return [...text].every((char) => ALPHANUMERIC.includes(char));
}

function segmentBits(text: string): { mode: number; bits: BitBuffer; count: number } {
  const bits = new BitBuffer();
  if (isAlphanumeric(text)) {
    for (let i = 0; i + 1 < text.length; i += 2) {
      bits.push(
        ALPHANUMERIC.indexOf(text[i]!) * 45 + ALPHANUMERIC.indexOf(text[i + 1]!),
        11
      );
    }
    if (text.length % 2 === 1) {
      bits.push(ALPHANUMERIC.indexOf(text.at(-1)!), 6);
    }
    return { mode: 0b0010, bits, count: text.length };
  }
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) bits.push(byte, 8);
  return { mode: 0b0100, bits, count: bytes.length };
}

function dataCodewords(text: string): { version: number; codewords: number[] } {
  const segment = segmentBits(text);
  for (let version = 1; version <= 6; version += 1) {
    const spec = VERSIONS[version]!;
    const capacity = spec.blocks.reduce((sum, n) => sum + n, 0) * 8;
    const countBits = segment.mode === 0b0010 ? 9 : 8;
    const needed = 4 + countBits + segment.bits.bits.length;
    if (needed > capacity) continue;
    const buffer = new BitBuffer();
    buffer.push(segment.mode, 4);
    buffer.push(segment.count, countBits);
    buffer.bits.push(...segment.bits.bits);
    buffer.push(0, Math.min(4, capacity - buffer.bits.length));
    buffer.push(0, (8 - (buffer.bits.length % 8)) % 8);
    const codewords: number[] = [];
    for (let i = 0; i < buffer.bits.length; i += 8) {
      codewords.push(
        buffer.bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0)
      );
    }
    for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) {
      codewords.push(pad);
    }
    return { version, codewords };
  }
  throw new Error('Text is too long for this QR encoder');
}

/** Data and error-correction codewords, interleaved by block. */
export function finalCodewords(text: string): {
  version: number;
  codewords: number[];
} {
  const { version, codewords } = dataCodewords(text);
  const spec = VERSIONS[version]!;
  const blocks: number[][] = [];
  let offset = 0;
  for (const length of spec.blocks) {
    blocks.push(codewords.slice(offset, offset + length));
    offset += length;
  }
  const ec = blocks.map((block) => reedSolomon(block, spec.ecPerBlock));
  const out: number[] = [];
  const longest = Math.max(...spec.blocks);
  for (let i = 0; i < longest; i += 1) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ec) out.push(block[i]!);
  }
  return { version, codewords: out };
}

// --- The matrix -----------------------------------------------------------

/** `modules[y][x]`, true for dark. */
export type QrMatrix = boolean[][];

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly version: number) {
    this.size = 17 + 4 * version;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false)
    );
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.finder(3, 3);
    this.finder(size - 4, 3);
    this.finder(3, size - 4);
    const centers = VERSIONS[this.version]!.alignment;
    for (const cy of centers) {
      for (const cx of centers) {
        const nearFinder =
          (cx === 6 && cy === 6) ||
          (cx === 6 && cy === size - 7) ||
          (cx === size - 7 && cy === 6);
        if (!nearFinder) this.alignment(cx, cy);
      }
    }
    // Reserve the format areas; drawFormat fills them.
    this.drawFormat(0);
  }

  private finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  private alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Format bits for level M (00) and `mask`, with their BCH code. */
  drawFormat(mask: number): void {
    const data = (0b00 << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  drawCodewords(codewords: readonly number[]): void {
    const bits: number[] = [];
    for (const byte of codewords) {
      for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
    }
    let index = 0;
    const { size } = this;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (!this.reserved[y]![x]) {
            // Remainder bits past the codewords are light.
            this.modules[y]![x] = index < bits.length && bits[index] === 1;
            index += 1;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    const test = MASKS[mask]!;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.reserved[y]![x] && test(x, y)) {
          this.modules[y]![x] = !this.modules[y]![x];
        }
      }
    }
  }

  /** The standard penalty: runs, 2×2 blocks, finder look-alikes, balance. */
  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const lines: boolean[][] = [];
    for (let i = 0; i < size; i += 1) {
      lines.push(modules[i]!);
      lines.push(modules.map((row) => row[i]!));
    }
    const finderLike = [
      [true, false, true, true, true, false, true, false, false, false, false],
      [false, false, false, false, true, false, true, true, true, false, true]
    ];
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      for (let i = 0; i + 11 <= size; i += 1) {
        for (const pattern of finderLike) {
          if (pattern.every((dark, k) => line[i + k] === dark)) score += 40;
        }
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (modules[y]![x]) dark += 1;
        if (
          x + 1 < size &&
          y + 1 < size &&
          modules[y]![x] === modules[y]![x + 1] &&
          modules[y]![x] === modules[y + 1]![x] &&
          modules[y]![x] === modules[y + 1]![x + 1]
        ) {
          score += 3;
        }
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** Encodes `text` as a QR matrix, choosing the mask with the lowest penalty. */
export function encodeQr(text: string): QrMatrix {
  const { version, codewords } = finalCodewords(text);
  let best: { matrix: Matrix; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = new Matrix(version);
    matrix.drawFunctionPatterns();
    matrix.drawCodewords(codewords);
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    const score = matrix.penalty();
    if (!best || score < best.score) best = { matrix, score };
  }
  return best!.matrix.modules;
}

/** An SVG path (one unit per module, 4-module quiet zone) for the dark modules. */
export function qrSvgPath(matrix: QrMatrix): { path: string; size: number } {
  const quiet = 4;
  let path = '';
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    })
  );
  return { path, size: matrix.length + quiet * 2 };
}
