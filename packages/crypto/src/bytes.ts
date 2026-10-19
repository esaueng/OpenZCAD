import { E2eeError } from './errors';

/** An ArrayBuffer-backed byte array, which every WebCrypto call accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Returns `bytes` itself when WebCrypto accepts it, otherwise a copy. */
export function asBytes(bytes: Uint8Array): Bytes {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Bytes)
    : copyBytes(bytes);
}

export function copyBytes(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

/** Concatenates an array of parts without spreading it into arguments. */
export function joinBytes(parts: readonly Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Concatenates a few parts; use `joinBytes` for an array of any length. */
export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
  return joinBytes(parts);
}

/**
 * Compares without an early exit, so timing does not reveal the length of
 * a matching prefix. Lengths are not secret.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const encoder = new TextEncoder();

export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

/** Domain-separation label for every HKDF info, AAD and signed message. */
export function label(purpose: string): Bytes {
  return utf8(`OpenZCAD E2EE ${purpose}`);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Bytes {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new E2eeError('invalid-argument', 'Not a hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(text: string): Bytes {
  if (
    typeof text !== 'string' ||
    !/^[A-Za-z0-9_-]*$/.test(text) ||
    text.length % 4 === 1
  ) {
    throw new E2eeError('malformed', 'Not a base64url string');
  }
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * A 256-bit hash as 40 decimal digits in eight groups of five (132.9
 * bits): the form people read aloud or compare by eye.
 */
export function toDigitGroups(hash: Uint8Array): string {
  if (hash.byteLength !== 32) {
    throw new E2eeError('invalid-argument', 'Digit groups need a 32-byte hash');
  }
  let value = 0n;
  for (const byte of hash) value = (value << 8n) | BigInt(byte);
  const digits = (value % 10n ** 40n).toString().padStart(40, '0');
  return digits.match(/.{5}/g)!.join(' ');
}

/** Crockford base32: no I, L, O or U, so it survives being read aloud. */
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encodes the first `bits` bits of `bytes` (all of them by default). */
export function toBase32(
  bytes: Uint8Array,
  bits = bytes.byteLength * 8
): string {
  let out = '';
  for (let bit = 0; bit < bits; bit += 5) {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const at = bit + i;
      const set =
        at < bits && at < bytes.byteLength * 8
          ? (bytes[at >> 3]! >> (7 - (at & 7))) & 1
          : 0;
      value = (value << 1) | set;
    }
    out += BASE32[value];
  }
  return out;
}

/**
 * Decodes Crockford base32 into `byteLength` bytes, folding the look-alike
 * letters (O→0, I/L→1) and ignoring case. Leftover bits must be zero.
 */
export function fromBase32(text: string, byteLength: number): Bytes {
  const normalized = text
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (normalized.length !== Math.ceil((byteLength * 8) / 5)) {
    throw new E2eeError('malformed', 'Base32 text has the wrong length');
  }
  const out = new Uint8Array(byteLength);
  let bit = 0;
  for (const char of normalized) {
    const value = BASE32.indexOf(char);
    if (value < 0) throw new E2eeError('malformed', 'Not a base32 character');
    for (let i = 4; i >= 0; i -= 1) {
      const set = (value >> i) & 1;
      if (bit < byteLength * 8) {
        out[bit >> 3]! |= set << (7 - (bit & 7));
      } else if (set) {
        throw new E2eeError('malformed', 'Base32 padding bits are not zero');
      }
      bit += 1;
    }
  }
  return out;
}

const MAX_U64 = Number.MAX_SAFE_INTEGER;

/**
 * A FIFO byte buffer for incremental readers and writers. Appends grow the
 * backing store geometrically and consumed bytes are dropped by moving the
 * live remainder only when space runs out, so every byte is copied a
 * bounded number of times however finely the input is sliced.
 */
export class ByteQueue {
  private buffer: Bytes = new Uint8Array(0);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  /** The live bytes, valid until the next `append` or `consume`. */
  view(): Bytes {
    return this.buffer.subarray(this.start, this.end);
  }

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const live = this.length;
    if (this.end + bytes.byteLength > this.buffer.byteLength) {
      const needed = live + bytes.byteLength;
      if (needed * 2 <= this.buffer.byteLength) {
        // Plenty of room once compacted: move the live bytes to the front.
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        const grown = new Uint8Array(
          Math.max(needed, this.buffer.byteLength * 2, 256)
        );
        grown.set(this.view());
        this.buffer = grown;
      }
      this.start = 0;
      this.end = live;
    }
    this.buffer.set(bytes, this.end);
    this.end += bytes.byteLength;
  }

  consume(count: number): void {
    this.start += count;
    if (this.start === this.end) this.start = this.end = 0;
  }
}

export function isUint(value: unknown, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= max
  );
}

/** Big-endian serializer for the fixed binary formats. */
export class ByteWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): this {
    return this.fixed(1, (view) => view.setUint8(0, value));
  }

  u16(value: number): this {
    return this.fixed(2, (view) => view.setUint16(0, value));
  }

  u32(value: number): this {
    return this.fixed(4, (view) => view.setUint32(0, value));
  }

  /** Unsigned 64-bit, limited to safe JavaScript integers. */
  u64(value: number): this {
    if (!isUint(value, MAX_U64)) {
      throw new E2eeError('invalid-argument', 'u64 value is out of range');
    }
    return this.fixed(8, (view) => {
      view.setUint32(0, Math.floor(value / 2 ** 32));
      view.setUint32(4, value >>> 0);
    });
  }

  bytes(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  finish(): Bytes {
    return joinBytes(this.parts);
  }

  private fixed(size: number, write: (view: DataView) => void): this {
    const bytes = new Uint8Array(size);
    write(new DataView(bytes.buffer));
    this.parts.push(bytes);
    return this;
  }
}

/** Bounds-checked big-endian reader; every overrun is a `malformed` error. */
export class ByteReader {
  private readonly view: DataView;
  private offset = 0;

  constructor(
    private readonly source: Uint8Array,
    private readonly what: string
  ) {
    this.view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength
    );
  }

  get remaining(): number {
    return this.source.byteLength - this.offset;
  }

  u8(): number {
    return this.view.getUint8(this.advance(1));
  }

  u16(): number {
    return this.view.getUint16(this.advance(2));
  }

  u32(): number {
    return this.view.getUint32(this.advance(4));
  }

  u64(): number {
    const at = this.advance(8);
    const high = this.view.getUint32(at);
    if (high > 0x1fffff) {
      throw new E2eeError(
        'malformed',
        `${this.what} holds an oversized integer`
      );
    }
    return high * 2 ** 32 + this.view.getUint32(at + 4);
  }

  bytes(length: number): Uint8Array {
    const at = this.advance(length);
    return this.source.subarray(at, at + length);
  }

  /** Throws unless every byte was consumed. */
  end(): void {
    if (this.remaining !== 0) {
      throw new E2eeError('malformed', `${this.what} has trailing bytes`);
    }
  }

  private advance(length: number): number {
    if (length > this.remaining) {
      throw new E2eeError('malformed', `${this.what} is truncated`);
    }
    const at = this.offset;
    this.offset += length;
    return at;
  }
}
