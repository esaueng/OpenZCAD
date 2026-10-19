import {
  ByteQueue,
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  fromBase64Url,
  isUint,
  label,
  snapshotBytes,
  toBase64Url,
  toHex,
  type Bytes
} from './bytes';
import {
  DEFAULT_MAX_PLAINTEXT_BYTES,
  compressStream,
  decompressStream,
  requireCompressionStreams,
  gunzipBytes,
  gzipBytes
} from './compression';
import { E2eeError } from './errors';
import {
  COMPRESSIONS,
  CONTENT_BLOB_KINDS,
  ENVELOPE_FIXED_PREFIX_BYTES,
  PLAINTEXT_CEILINGS,
  DEFAULT_CHUNK_SIZE,
  HASH_BYTES,
  MAX_CHUNK_SIZE,
  MAX_HEADER_BYTES,
  checkHeader,
  decodeEnvelopePrefix,
  encodeEnvelopePrefix,
  envelopePrefixLength,
  isEnvelopeId,
  normalizeProjectHeader,
  type Compression,
  type ContentBlobHeader,
  type ContentBlobKind,
  type EnvelopeHeader,
  type EnvelopePrefix,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit,
  type ProjectEnvelopeKind
} from './header';
import {
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  KEY_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  sha256,
  subtle,
  systemRandom,
  type RandomSource
} from './primitives';

const MAX_CHUNK_INDEX = 0xffffffff;
const BLOB_ID_BYTES = 16;

// --- Single-use envelope keys ---------------------------------------------

let readKey: (key: EnvelopeKey) => Bytes;
let createKey: (bytes: Uint8Array) => EnvelopeKey;
const usedKeys = new WeakSet<EnvelopeKey>();
// `private` is erased from the emitted JavaScript, so the constructor also
// demands this unexported token: without it a caller could build a second
// instance from `key.bytes` that `usedKeys` would not recognise.
const constructionToken: unique symbol = Symbol('EnvelopeKey');

/**
 * A fresh random 256-bit key that encrypts exactly one envelope. Chunk
 * nonces are deterministic, so a second envelope under the same key would
 * repeat them; the encoder therefore consumes the key and refuses it again
 * (`key-reused`). A retried upload re-sends the same ciphertext instead.
 * Decryption takes the raw bytes and never needs an `EnvelopeKey`.
 */
export class EnvelopeKey {
  readonly #bytes: Bytes;

  static {
    readKey = (key) => key.#bytes;
    createKey = (bytes) => new EnvelopeKey(constructionToken, copyBytes(bytes));
  }

  private constructor(token: typeof constructionToken, bytes: Bytes) {
    if (token !== constructionToken) {
      throw new E2eeError(
        'invalid-argument',
        'Create envelope keys with EnvelopeKey.generate()'
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== KEY_BYTES) {
      throw new E2eeError('invalid-argument', 'Envelope keys are 32 bytes');
    }
    this.#bytes = bytes;
  }

  static generate(): EnvelopeKey {
    return new EnvelopeKey(constructionToken, systemRandom(KEY_BYTES));
  }

  /** The raw key, to wrap under the project key or record in a reference. */
  get bytes(): Bytes {
    return copyBytes(this.#bytes);
  }

  /** True once an envelope has been encrypted under this key. */
  get used(): boolean {
    return usedKeys.has(this);
  }
}

/** @internal Test vectors only: production keys come from `generate()`. */
export function envelopeKeyFromBytes(bytes: Uint8Array): EnvelopeKey {
  return createKey(bytes);
}

function consumeKey(key: EnvelopeKey): Bytes {
  if (!(key instanceof EnvelopeKey)) {
    throw new E2eeError(
      'invalid-argument',
      'Encrypt with an EnvelopeKey from EnvelopeKey.generate()'
    );
  }
  if (usedKeys.has(key)) {
    throw new E2eeError(
      'key-reused',
      'This key already encrypted an envelope; generate a new one'
    );
  }
  usedKeys.add(key);
  return readKey(key);
}

async function importChunkKey(
  key: Uint8Array,
  usage: KeyUsage
): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_BYTES) {
    throw new E2eeError('invalid-argument', 'Envelope keys are 32 bytes');
  }
  return subtle().importKey('raw', copyBytes(key), 'AES-GCM', false, [usage]);
}

// --- Chunk layout ---------------------------------------------------------

/** STREAM nonce: `uint88_be(index) || last`, last = 0x01 on the final chunk. */
export function chunkNonce(index: number, final: boolean): Bytes {
  const nonce = new Uint8Array(GCM_IV_BYTES);
  new DataView(nonce.buffer).setUint32(7, index);
  nonce[11] = final ? 1 : 0;
  return nonce;
}

/** The serialized prefix (magic, version, header) and the u32 chunk index. */
export function chunkAad(prefix: Uint8Array, index: number): Bytes {
  return new ByteWriter().bytes(prefix).u32(index).finish();
}

/** Ciphertext length of a payload: one tag per chunk, at least one chunk. */
export function envelopeBodyLength(
  payloadLength: number,
  chunkSize: number
): number {
  const chunks = Math.max(1, Math.ceil(payloadLength / chunkSize));
  return payloadLength + chunks * GCM_TAG_BYTES;
}

/**
 * Commits to a content blob's exact ciphertext with bounded state, however
 * many chunks it has: h0 = SHA-256(label), then for the prefix and each
 * chunk in order h = SHA-256(h | SHA-256(part)). The final h is the hash.
 * Parts are folded in strictly in order; callers await each `add`.
 */
class CiphertextHasher {
  private state: Promise<Bytes> = sha256(label('v1 content blob hash'));

  add(part: Uint8Array): Promise<Bytes> {
    const next = this.state.then(async (state) =>
      sha256(concatBytes(state, await sha256(part)))
    );
    this.state = next;
    return next;
  }

  async finish(): Promise<Bytes> {
    return copyBytes(await this.state);
  }
}

// --- Writer ---------------------------------------------------------------

/** Largest single `write`: one maximum-size chunk. */
export const MAX_WRITER_WRITE_BYTES = MAX_CHUNK_SIZE;
/** Most records one `write` may seal, so each call's work stays bounded. */
export const MAX_WRITER_WRITE_RECORDS = 1024;

/**
 * Incremental encryptor. Emit `prefix` first, then everything `write` and
 * `finish` return, in order. One `write` takes at most
 * `MAX_WRITER_WRITE_BYTES` and `MAX_WRITER_WRITE_RECORDS` chunks' worth
 * (one `chunkSize` slice always fits); a larger write is refused
 * (`invalid-argument`) without changing the writer, so slice and retry. Chunk `i` always starts at
 * `prefix.length + i * (chunkSize + 16)`, so multipart part boundaries and
 * ranged reads need no alignment with chunks. A full chunk is held back
 * until the next write or `finish` shows whether it is the last.
 *
 * The writer encrypts the payload as given: when `header.compression` is
 * `gzip`, feed it gzip bytes (or use the stream helper).
 */
export class EnvelopeWriter<H extends EnvelopeHeader = EnvelopeHeader> {
  private readonly pending = new ByteQueue();
  private written = 0;
  private index = 0;
  private state: 'open' | 'busy' | 'closed' = 'open';
  private readonly hasher: CiphertextHasher | null;
  private hash: Bytes | null = null;
  /**
   * The canonical prefix every chunk's AAD binds. Consumers only ever see
   * copies, so one that transfers or edits the bytes it was handed (say,
   * to an upload worker) cannot change what later chunks authenticate.
   */
  readonly #prefix: Bytes;
  /** Frozen, so a consumer cannot alter the chunking mid-envelope. */
  readonly header: H;

  constructor(
    header: H,
    prefix: Bytes,
    private readonly key: CryptoKey,
    /**
     * Uncompressed payloads are the plaintext, so the writer refuses any
     * total other than the declared size. A gzip payload may not exceed
     * what readers accept for its header (`payloadBound`); its plaintext
     * size is the caller's to guarantee (the stream helper checks it).
     * Only the hostile-writer test helper turns this off.
     */
    private readonly enforceLimits = true
  ) {
    const frozen: H = { ...header };
    Object.freeze(frozen);
    this.header = frozen;
    this.#prefix = copyBytes(prefix);
    this.hasher = header.class === 'content' ? new CiphertextHasher() : null;
    // Folded in before the first chunk, which awaits it.
    this.hasher?.add(this.#prefix).catch(() => undefined);
  }

  /** The envelope prefix to emit first; a fresh copy on each read. */
  get prefix(): Bytes {
    return copyBytes(this.#prefix);
  }

  /** Encrypts every chunk that is now known not to be the last. */
  async write(payload: Uint8Array): Promise<Bytes[]> {
    if (!(payload instanceof Uint8Array)) {
      throw new E2eeError('invalid-argument', 'Write payload bytes');
    }
    if (payload.byteLength > MAX_WRITER_WRITE_BYTES) {
      throw new E2eeError(
        'invalid-argument',
        `Write at most ${MAX_WRITER_WRITE_BYTES} bytes at a time`
      );
    }
    // The loop below seals every whole chunk but the last one held back.
    const size = this.header.chunkSize;
    const records = Math.ceil(
      (this.pending.length + payload.byteLength - size) / size
    );
    if (records > MAX_WRITER_WRITE_RECORDS) {
      throw new E2eeError(
        'invalid-argument',
        `Write at most ${MAX_WRITER_WRITE_RECORDS} chunks at a time`
      );
    }
    return this.exclusive(async () => {
      this.written += payload.byteLength;
      if (
        this.enforceLimits &&
        this.header.compression === 'none' &&
        this.written > this.header.plaintextLength
      ) {
        throw new E2eeError(
          'invalid-argument',
          `Payload is longer than the declared ${this.header.plaintextLength} bytes`
        );
      }
      if (
        this.enforceLimits &&
        this.header.compression === 'gzip' &&
        this.written > payloadBound(this.header)
      ) {
        // Every reader would refuse it: stop before sealing more.
        throw new E2eeError(
          'limit-exceeded',
          `A gzip payload for ${this.header.plaintextLength} bytes may not exceed ${payloadBound(this.header)} bytes`
        );
      }
      // WebCrypto copies its input when called, so sealing straight from
      // the queue is safe; a full chunk waits until more data shows it is
      // not the last.
      this.pending.append(payload);
      const out: Bytes[] = [];
      while (this.pending.length > size) {
        out.push(await this.seal(this.pending.view().subarray(0, size), false));
        this.pending.consume(size);
      }
      return out;
    });
  }

  /** Encrypts the final chunk (possibly empty) and closes the writer. */
  async finish(): Promise<Bytes> {
    const last = await this.exclusive(async () => {
      if (
        this.enforceLimits &&
        this.header.compression === 'none' &&
        this.written !== this.header.plaintextLength
      ) {
        throw new E2eeError(
          'invalid-argument',
          `Payload is ${this.written} bytes, not the declared ${this.header.plaintextLength}`
        );
      }
      const chunk = await this.seal(this.pending.view(), true);
      if (this.hasher) this.hash = await this.hasher.finish();
      return chunk;
    });
    this.state = 'closed';
    return last;
  }

  /** Content blobs: the ciphertext hash, available after `finish`. */
  get ciphertextHash(): Bytes {
    if (!this.hash) {
      throw new E2eeError(
        'invalid-argument',
        'The ciphertext hash exists only for a finished content blob'
      );
    }
    return copyBytes(this.hash);
  }

  /** Total envelope length for a payload of `payloadLength` bytes. */
  encryptedLength(payloadLength: number): number {
    return (
      this.#prefix.byteLength +
      envelopeBodyLength(payloadLength, this.header.chunkSize)
    );
  }

  private async seal(chunk: Uint8Array, final: boolean): Promise<Bytes> {
    if (this.index > MAX_CHUNK_INDEX) {
      throw new E2eeError('limit-exceeded', 'Envelope has too many chunks');
    }
    const index = this.index;
    this.index += 1;
    const sealed = await aesGcmEncrypt(
      this.key,
      chunkNonce(index, final),
      chunkAad(this.#prefix, index),
      chunk
    );
    await this.hasher?.add(sealed);
    return sealed;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      throw new E2eeError(
        'invalid-argument',
        this.state === 'busy'
          ? 'Await each EnvelopeWriter call before the next'
          : 'EnvelopeWriter is already finished'
      );
    }
    this.state = 'busy';
    try {
      return await task();
    } catch (error) {
      this.state = 'closed';
      throw error;
    } finally {
      if (this.state === 'busy') this.state = 'open';
    }
  }
}

/** The key each writer consumed, so a reference can only carry that key. */
const writerKeys = new WeakMap<EnvelopeWriter, EnvelopeKey>();

async function createWriter<H extends EnvelopeHeader>(
  key: EnvelopeKey,
  header: H,
  enforceLimits = true
): Promise<EnvelopeWriter<H>> {
  const prefix = encodeEnvelopePrefix(header);
  const raw = consumeKey(key);
  const writer = new EnvelopeWriter(
    header,
    prefix,
    await importChunkKey(raw, 'encrypt'),
    enforceLimits
  );
  writerKeys.set(writer, key);
  return writer;
}

// --- Reader ---------------------------------------------------------------

export interface ReadOptions {
  /** Ceiling on the payload and on the decompressed plaintext. Default 128 MiB. */
  readonly maxPlaintextBytes?: number;
}

/** Largest single `push`: one maximum-size record with its tag. */
export const MAX_READER_PUSH_BYTES = MAX_CHUNK_SIZE + GCM_TAG_BYTES;
/** Most records one `push` may open, so each call's work stays bounded. */
export const MAX_READER_PUSH_RECORDS = 1024;

/**
 * Incremental decryptor. Push envelope bytes in any slicing up to
 * `MAX_READER_PUSH_BYTES` per call and `MAX_READER_PUSH_RECORDS` records'
 * worth (`preferredPushBytes` is always within both); a larger push is
 * refused (`invalid-argument`). Each call returns the payload chunks that
 * authenticated. Output is not complete
 * until `finish` succeeds: only then has the final-chunk nonce proved that
 * nothing was cut off the end, and for a content blob that its ciphertext
 * hash matches the reference. Any failure poisons the reader.
 */
export class EnvelopeReader<H extends EnvelopeHeader = EnvelopeHeader> {
  private readonly buffered = new ByteQueue();
  private parsed: EnvelopePrefix | null = null;
  private cryptoKey: CryptoKey | null = null;
  private index = 0;
  private produced = 0;
  private verified = false;
  private state: 'open' | 'busy' | 'closed' = 'open';
  private readonly hasher: CiphertextHasher | null;
  private readonly callerLimit: number | undefined;
  /** Payload limit: the caller's until the header is authenticated. */
  private maxBytes: number;

  private readonly key: Uint8Array;
  private readonly expectedHash: Uint8Array | null;

  constructor(
    key: Uint8Array,
    private readonly accept: (header: EnvelopeHeader) => void,
    expectedHash: Uint8Array | null,
    options: ReadOptions = {}
  ) {
    // Copies: both are read only after awaits, when the caller's arrays may
    // have changed. (A non-array key is refused when the prefix arrives.)
    // Only a key of the right size is worth copying; any other is refused
    // when the prefix arrives, so it is passed through as given.
    this.key =
      key instanceof Uint8Array && key.byteLength === KEY_BYTES
        ? copyBytes(key)
        : key;
    this.expectedHash =
      expectedHash instanceof Uint8Array ? copyBytes(expectedHash) : null;
    this.hasher = expectedHash ? new CiphertextHasher() : null;
    checkCallerLimit(options.maxPlaintextBytes);
    this.callerLimit = options.maxPlaintextBytes;
    this.maxBytes = maxPayloadBytes(
      options.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES
    );
  }

  /** The header, once the first chunk has authenticated it. */
  get header(): H | null {
    return this.verified && this.parsed ? (this.parsed.header as H) : null;
  }

  /**
   * A good size for the next `push`: one encrypted chunk once the header is
   * known, a small block before. Pushing at most this much keeps each call's
   * output to about one record, so callers can honour backpressure.
   */
  get preferredPushBytes(): number {
    if (this.parsed) return this.parsed.header.chunkSize + GCM_TAG_BYTES;
    // Before the header: just enough to complete the prefix, so the first
    // push does not also carry a run of records.
    const have = this.buffered.length;
    if (have < ENVELOPE_FIXED_PREFIX_BYTES) {
      return ENVELOPE_FIXED_PREFIX_BYTES - have;
    }
    try {
      const length = envelopePrefixLength(this.buffered.view());
      return length === null ? 1 : Math.max(1, length - have);
    } catch {
      return 1; // `push` reports the malformed prefix.
    }
  }

  async push(bytes: Uint8Array): Promise<Bytes[]> {
    if (!(bytes instanceof Uint8Array)) {
      throw new E2eeError('invalid-argument', 'Push envelope bytes');
    }
    if (bytes.byteLength > MAX_READER_PUSH_BYTES) {
      throw new E2eeError(
        'invalid-argument',
        `Push at most ${MAX_READER_PUSH_BYTES} bytes at a time`
      );
    }
    return this.exclusive(async () => {
      this.buffered.append(bytes);
      if (!this.parsed && !(await this.readPrefix())) return [];
      const cipherSize = this.parsed!.header.chunkSize + GCM_TAG_BYTES;
      // The loop below opens every whole record but the last one buffered.
      const records = Math.ceil(
        (this.buffered.length - cipherSize) / cipherSize
      );
      if (records > MAX_READER_PUSH_RECORDS) {
        throw new E2eeError(
          'invalid-argument',
          `Push at most ${MAX_READER_PUSH_RECORDS} records at a time; use preferredPushBytes`
        );
      }
      const out: Bytes[] = [];
      while (this.buffered.length > cipherSize) {
        out.push(
          await this.open(this.buffered.view().subarray(0, cipherSize), false)
        );
        this.buffered.consume(cipherSize);
      }
      return out;
    });
  }

  /** Authenticates the final chunk; throws if anything was cut or swapped. */
  async finish(): Promise<Bytes[]> {
    const out = await this.exclusive(async () => {
      if (!this.parsed && !(await this.readPrefix())) {
        throw new E2eeError('malformed', 'Envelope ends inside its header');
      }
      if (this.buffered.length < GCM_TAG_BYTES) {
        throw new E2eeError('malformed', 'Envelope ends without a final chunk');
      }
      const last = await this.open(this.buffered.view(), true);
      // An uncompressed payload is the plaintext: it must be exactly the
      // declared size, or a key holder could pass off a truncated blob as
      // complete. (Gzip payloads are checked once inflated.)
      const { header } = this.parsed!;
      if (
        header.compression === 'none' &&
        this.produced !== header.plaintextLength
      ) {
        throw new E2eeError(
          'malformed',
          `Plaintext is ${this.produced} bytes, not the declared ${header.plaintextLength}`
        );
      }
      if (this.hasher && this.expectedHash) {
        const hash = await this.hasher.finish();
        if (!equalBytes(hash, this.expectedHash)) {
          throw new E2eeError(
            'authentication-failed',
            'Content blob ciphertext does not match its reference hash'
          );
        }
      }
      return [last];
    });
    this.state = 'closed';
    return out;
  }

  private async readPrefix(): Promise<boolean> {
    const length = envelopePrefixLength(this.buffered.view());
    if (length === null || this.buffered.length < length) return false;
    this.parsed = decodeEnvelopePrefix(
      this.buffered.view().subarray(0, length)
    );
    this.buffered.consume(length);
    await this.hasher?.add(this.parsed.prefix);
    this.cryptoKey = await importChunkKey(this.key, 'decrypt');
    return true;
  }

  private async open(ciphertext: Uint8Array, final: boolean): Promise<Bytes> {
    if (this.index > MAX_CHUNK_INDEX) {
      throw new E2eeError('limit-exceeded', 'Envelope has too many chunks');
    }
    const index = this.index;
    await this.hasher?.add(ciphertext);
    const plaintext = await aesGcmDecrypt(
      this.cryptoKey!,
      chunkNonce(index, final),
      chunkAad(this.parsed!.prefix, index),
      ciphertext,
      `Envelope chunk ${index}`
    );
    this.index += 1;
    if (!this.verified) {
      this.verified = true;
      this.accept(this.parsed!.header);
      // Now that the header is authentic, hold the payload to what it can
      // produce: a few declared bytes must not cost 128 MiB of empty
      // deflate blocks to download, decrypt and inflate.
      this.maxBytes = Math.min(
        this.maxBytes,
        payloadBound(this.parsed!.header, this.callerLimit)
      );
    }
    this.produced += plaintext.byteLength;
    if (this.produced > this.maxBytes) {
      throw new E2eeError(
        'limit-exceeded',
        `Payload is larger than ${this.maxBytes} bytes`
      );
    }
    return plaintext;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.state !== 'open') {
      throw new E2eeError(
        'invalid-argument',
        this.state === 'busy'
          ? 'Await each EnvelopeReader call before the next'
          : 'EnvelopeReader is finished or failed'
      );
    }
    this.state = 'busy';
    try {
      return await task();
    } catch (error) {
      this.state = 'closed';
      throw error;
    } finally {
      if (this.state === 'busy') this.state = 'open';
    }
  }
}

export interface PayloadLimits {
  readonly kind: ProjectEnvelopeKind | ContentBlobKind;
  readonly compression: Compression;
  /** The exact plaintext size the header or reference declares. */
  readonly declaredLength: number;
  /** An extra ceiling from the caller, if lower. */
  readonly maxPlaintextBytes?: number;
}

/**
 * The largest payload a plaintext limit allows. A gzip payload of
 * incompressible data is slightly larger than its plaintext, so deflate's
 * worst-case overhead is allowed on top.
 */
function maxPayloadBytes(plaintextLimit: number): number {
  return plaintextLimit + Math.ceil(plaintextLimit / 1024) + 1024;
}

/**
 * The largest payload one header can legitimately carry: exactly its
 * plaintext cap uncompressed, the cap plus deflate overhead with gzip.
 */
function payloadBound(
  header: EnvelopeHeader,
  maxPlaintextBytes?: number
): number {
  const cap = plaintextCap({
    kind: header.kind,
    compression: header.compression,
    declaredLength: header.plaintextLength,
    maxPlaintextBytes
  });
  return header.compression === 'none' ? cap : maxPayloadBytes(cap);
}

function checkCallerLimit(limit: number | undefined): void {
  if (limit !== undefined && !isUint(limit, Number.MAX_SAFE_INTEGER)) {
    throw new E2eeError(
      'invalid-argument',
      'maxPlaintextBytes must be a non-negative safe integer'
    );
  }
}

/**
 * The plaintext cap for one payload: the smaller of its declared size, its
 * kind's ceiling and the caller's limit. A declared size above the ceiling
 * is refused before any decompression (`limit-exceeded`).
 */
export function plaintextCap(limits: PayloadLimits): number {
  // An unknown kind would look up no ceiling, and NaN would then pass every
  // size comparison: validate every input before computing the cap.
  if (
    typeof limits?.kind !== 'string' ||
    !Object.hasOwn(PLAINTEXT_CEILINGS, limits.kind) ||
    !COMPRESSIONS.includes(limits.compression) ||
    !isUint(limits.declaredLength, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError(
      'invalid-argument',
      'Payload limits need a known kind and compression and a whole-byte length'
    );
  }
  checkCallerLimit(limits.maxPlaintextBytes);
  const ceiling = Math.min(
    PLAINTEXT_CEILINGS[limits.kind],
    limits.maxPlaintextBytes ?? Number.MAX_SAFE_INTEGER
  );
  if (limits.declaredLength > ceiling) {
    throw new E2eeError(
      'limit-exceeded',
      `A ${limits.kind} may not exceed ${ceiling} bytes`
    );
  }
  return limits.declaredLength;
}

function checkDeclaredLength(actual: number, declared: number): void {
  if (actual !== declared) {
    throw new E2eeError(
      'malformed',
      `Plaintext is ${actual} bytes, not the declared ${declared}`
    );
  }
}

/**
 * The package's decode step for a decrypted payload: inflates gzip as a
 * stream that stops the moment output passes the cap (`plaintextCap`), and
 * fails unless the result is exactly the declared size. This is what keeps
 * a small, highly compressible envelope from exhausting the browser before
 * any validator runs.
 */
export async function decodePayload(
  payload: Uint8Array,
  limits: PayloadLimits
): Promise<Bytes> {
  const cap = plaintextCap(limits);
  if (limits.compression === 'none' && payload.byteLength > cap) {
    throw new E2eeError(
      'limit-exceeded',
      `Plaintext is larger than the declared ${cap} bytes`
    );
  }
  // The same compressed bound readers enforce: a stream of empty deflate
  // blocks inflates to almost nothing but costs work and memory per byte.
  if (
    limits.compression === 'gzip' &&
    payload.byteLength > maxPayloadBytes(cap)
  ) {
    throw new E2eeError(
      'limit-exceeded',
      `A gzip payload for ${cap} bytes may not exceed ${maxPayloadBytes(cap)} bytes`
    );
  }
  const plaintext =
    limits.compression === 'gzip'
      ? await gunzipBytes(payload, cap)
      : asBytes(payload);
  checkDeclaredLength(plaintext.byteLength, limits.declaredLength);
  return plaintext;
}

/**
 * Encrypts a whole payload into one preallocated buffer, a chunk-size slice
 * at a time, so no per-chunk array list is kept or spread.
 */
async function sealWhole(
  writer: EnvelopeWriter,
  payload: Uint8Array
): Promise<Bytes> {
  const out = new Uint8Array(writer.encryptedLength(payload.byteLength));
  out.set(writer.prefix);
  let at = writer.prefix.byteLength;
  const step = writer.header.chunkSize;
  for (let offset = 0; offset < payload.byteLength; offset += step) {
    for (const chunk of await writer.write(
      payload.subarray(offset, offset + step)
    )) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
  }
  const last = await writer.finish();
  out.set(last, at);
  return out;
}

/**
 * A copy of a one-shot envelope, taken before the first await so the bytes
 * read are the bytes passed. It never copies more than the header can
 * legitimately use plus one record, so an oversized body costs no more
 * than a valid one; the reader still meets the excess and fails exactly as
 * it would on the original. A prefix that does not decode is copied only
 * as far as the reader will look before refusing it.
 */
function boundedSnapshot(
  envelope: Uint8Array,
  maxPlaintextBytes: number | undefined
): Bytes {
  if (!(envelope instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Envelope must be a Uint8Array');
  }
  let header: EnvelopeHeader | null = null;
  let prefixLength = 0;
  try {
    const length = envelopePrefixLength(envelope);
    if (length !== null && envelope.byteLength >= length) {
      header = decodeEnvelopePrefix(envelope.subarray(0, length)).header;
      prefixLength = length;
    }
  } catch {
    header = null; // The reader reports it from the copy.
  }
  const limit = header
    ? prefixLength +
      envelopeBodyLength(
        payloadBound(header, maxPlaintextBytes),
        header.chunkSize
      ) +
      header.chunkSize +
      GCM_TAG_BYTES
    : ENVELOPE_FIXED_PREFIX_BYTES + MAX_HEADER_BYTES;
  return copyBytes(envelope.subarray(0, Math.min(envelope.byteLength, limit)));
}

/**
 * Decrypts a whole envelope into one buffer, a record at a time, without
 * keeping per-chunk arrays. The buffer is sized once the first chunk has
 * authenticated the header, to the payload that header can legitimately
 * produce, so an oversized body is refused instead of being mirrored.
 */
async function readWhole<H extends EnvelopeHeader>(
  reader: EnvelopeReader<H>,
  envelope: Uint8Array,
  declaredLength: (header: H) => number,
  maxPlaintextBytes: number | undefined
): Promise<{ header: H; plaintext: Bytes }> {
  // Decryption awaits between records, so read a copy taken now.
  envelope = boundedSnapshot(envelope, maxPlaintextBytes);
  let payloadBuffer: Bytes | null = null;
  let at = 0;
  const take = (parts: readonly Bytes[]) => {
    if (parts.length === 0) return;
    if (!payloadBuffer) {
      const bound = payloadBound(reader.header!, maxPlaintextBytes);
      payloadBuffer = new Uint8Array(Math.min(envelope.byteLength, bound));
    }
    for (const part of parts) {
      if (at + part.byteLength > payloadBuffer.byteLength) {
        throw new E2eeError(
          'limit-exceeded',
          `Payload is larger than its header allows (${payloadBuffer.byteLength} bytes)`
        );
      }
      payloadBuffer.set(part, at);
      at += part.byteLength;
    }
  };
  for (let offset = 0; offset < envelope.byteLength;) {
    const slice = envelope.subarray(offset, offset + reader.preferredPushBytes);
    offset += slice.byteLength;
    take(await reader.push(slice));
  }
  take(await reader.finish());
  const header = reader.header!;
  const plaintext = await decodePayload(payloadBuffer!.subarray(0, at), {
    kind: header.kind,
    compression: header.compression,
    declaredLength: declaredLength(header),
    maxPlaintextBytes
  });
  return { header, plaintext };
}

function checkEncryptSize(
  kind: ProjectEnvelopeKind | ContentBlobKind,
  length: number
): void {
  if (!Object.hasOwn(PLAINTEXT_CEILINGS, kind)) {
    throw new E2eeError('invalid-argument', `Unknown envelope kind ${kind}`);
  }
  if (length > PLAINTEXT_CEILINGS[kind]) {
    throw new E2eeError(
      'limit-exceeded',
      `A ${kind} may not exceed ${PLAINTEXT_CEILINGS[kind]} bytes`
    );
  }
}

function mismatch(field: string): never {
  throw new E2eeError(
    'context-mismatch',
    `Envelope ${field} is not the one requested`
  );
}

// --- Project envelopes ----------------------------------------------------

/** Fields a reader insists on; an authentic envelope that differs is refused. */
export interface ProjectEnvelopeExpectation {
  readonly projectId?: string;
  readonly kind?: ProjectEnvelopeKind;
  readonly documentVersion?: number;
  readonly keyEpoch?: number;
  readonly schemaVersion?: number;
  readonly previousVersionHash?: Uint8Array | null;
  readonly rosterEntryHash?: Uint8Array;
}

export interface DecryptProjectEnvelopeOptions extends ReadOptions {
  readonly expect?: ProjectEnvelopeExpectation;
}

function sameHash(want: Uint8Array | null, have: Uint8Array | null): boolean {
  return want === null || have === null
    ? want === have
    : equalBytes(want, have);
}

function acceptProject(given: ProjectEnvelopeExpectation) {
  // Checked only once the first chunk decrypts, after awaits: hold the
  // expectation as passed, hashes included.
  const copyHash = <T>(hash: T): T =>
    hash instanceof Uint8Array ? (copyBytes(hash) as T) : hash;
  const expect: ProjectEnvelopeExpectation = {
    ...given,
    previousVersionHash: copyHash(given.previousVersionHash),
    rosterEntryHash: copyHash(given.rosterEntryHash)
  };
  return (header: EnvelopeHeader): void => {
    if (header.class !== 'project') mismatch('class');
    for (const field of [
      'projectId',
      'kind',
      'documentVersion',
      'keyEpoch',
      'schemaVersion'
    ] as const) {
      if (expect[field] !== undefined && expect[field] !== header[field]) {
        mismatch(field);
      }
    }
    if (
      expect.previousVersionHash !== undefined &&
      !sameHash(expect.previousVersionHash, header.previousVersionHash)
    ) {
      mismatch('previousVersionHash');
    }
    if (
      expect.rosterEntryHash !== undefined &&
      !sameHash(expect.rosterEntryHash, header.rosterEntryHash)
    ) {
      mismatch('rosterEntryHash');
    }
  };
}

/**
 * Encrypts one project envelope (a document version, measurements, view
 * state or share snapshot) under its own fresh version key. Wrap
 * `key.bytes` under the project key with `wrapKey` (`version-key`).
 */
export async function encryptProjectEnvelope(
  key: EnvelopeKey,
  init: ProjectEnvelopeHeaderInit,
  plaintext: Uint8Array
): Promise<Bytes> {
  const header = normalizeProjectHeader(init, plaintext.byteLength);
  checkEncryptSize(header.kind, plaintext.byteLength);
  // Encrypt a copy taken before the first await: an edit to the caller's
  // array meanwhile would otherwise seal bytes the header does not describe.
  // Already size-checked against the kind's ceiling above.
  const data = snapshotBytes(plaintext, 'Plaintext', Number.MAX_SAFE_INTEGER);
  const writer = await createWriter(key, header);
  const payload =
    writer.header.compression === 'gzip' ? await gzipBytes(data) : data;
  return sealWhole(writer, payload);
}

/**
 * @internal Tests only: encrypts `payload` as given (already compressed if
 * the header says so) under an arbitrary header, the way a hostile key
 * holder could, so decode limits can be exercised.
 */
export async function encryptWithHeaderForTests<H extends EnvelopeHeader>(
  key: EnvelopeKey,
  header: H,
  payload: Uint8Array
): Promise<{ envelope: Bytes; writer: EnvelopeWriter<H> }> {
  const writer = await createWriter(key, header, false);
  return { envelope: await sealWhole(writer, payload), writer };
}

export async function decryptProjectEnvelope(
  versionKey: Uint8Array,
  envelope: Uint8Array,
  options: DecryptProjectEnvelopeOptions = {}
): Promise<{ header: ProjectEnvelopeHeader; plaintext: Bytes }> {
  const reader = new EnvelopeReader<ProjectEnvelopeHeader>(
    versionKey,
    acceptProject(options.expect ?? {}),
    null,
    options
  );
  return readWhole(
    reader,
    envelope,
    (header) => header.plaintextLength,
    options.maxPlaintextBytes
  );
}

// --- Content blobs --------------------------------------------------------

/**
 * Everything needed to fetch and trust a content blob. It lives inside the
 * encrypted body of the project envelope that references the blob, which is
 * what authenticates it; the blob itself names no project.
 */
export interface ContentBlobReference {
  readonly blobId: string;
  readonly kind: ContentBlobKind;
  readonly key: Bytes;
  readonly ciphertextHash: Bytes;
  /** Exact plaintext size; decryption enforces it. */
  readonly plaintextLength: number;
}

export interface ContentBlobOptions {
  /** Defaults to `gzip`. */
  readonly compression?: Compression;
  /** Defaults to 1 MiB. */
  readonly chunkSize?: number;
}

/**
 * Writers and streams emit the header first, so they need the exact
 * plaintext size (before compression) up front; the stream helper refuses
 * plaintext that ends up longer or shorter.
 */
export interface ContentBlobWriterOptions extends ContentBlobOptions {
  readonly plaintextLength: number;
}

/** @internal Tests inject the blob id source; production uses `createContentBlobWriter`. */
export async function createContentBlobWriterWith(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  options: ContentBlobWriterOptions,
  random: RandomSource
): Promise<EnvelopeWriter<ContentBlobHeader>> {
  const header: ContentBlobHeader = {
    class: 'content',
    kind,
    blobId: toHex(random(BLOB_ID_BYTES)),
    compression: options.compression ?? 'gzip',
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    plaintextLength: options.plaintextLength
  };
  checkHeader(header, 'invalid-argument');
  checkEncryptSize(kind, header.plaintextLength);
  return createWriter(key, header);
}

/**
 * Starts a content blob under a fresh random id. After `finish`, build its
 * reference with `contentBlobReference(writer)`.
 */
export async function createContentBlobWriter(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  options: ContentBlobWriterOptions
): Promise<EnvelopeWriter<ContentBlobHeader>> {
  return createContentBlobWriterWith(key, kind, options, systemRandom);
}

/**
 * The reference for a finished content blob writer, carrying the key the
 * writer itself consumed (it cannot be paired with any other key).
 */
export function contentBlobReference(
  writer: EnvelopeWriter<ContentBlobHeader>
): ContentBlobReference {
  const key = writerKeys.get(writer);
  if (!key || writer.header?.class !== 'content') {
    throw new E2eeError(
      'invalid-argument',
      'Not a content blob writer from createContentBlobWriter'
    );
  }
  return {
    blobId: writer.header.blobId,
    kind: writer.header.kind,
    key: key.bytes,
    ciphertextHash: writer.ciphertextHash,
    plaintextLength: writer.header.plaintextLength
  };
}

/** @internal Tests inject the blob id source; production uses `encryptContentBlob`. */
export async function encryptContentBlobWith(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  plaintext: Uint8Array,
  options: ContentBlobOptions,
  random: RandomSource
): Promise<{ envelope: Bytes; reference: ContentBlobReference }> {
  // Size-check, then copy before the first await (see encryptProjectEnvelope).
  if (!(plaintext instanceof Uint8Array)) {
    throw new E2eeError('invalid-argument', 'Plaintext must be a Uint8Array');
  }
  checkEncryptSize(kind, plaintext.byteLength);
  const data = copyBytes(plaintext);
  const writer = await createContentBlobWriterWith(
    key,
    kind,
    { ...options, plaintextLength: data.byteLength },
    random
  );
  const payload =
    writer.header.compression === 'gzip' ? await gzipBytes(data) : data;
  const envelope = await sealWhole(writer, payload);
  return {
    envelope,
    reference: contentBlobReference(writer)
  };
}

/** Encrypts a whole content blob under a fresh random id. */
export async function encryptContentBlob(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  plaintext: Uint8Array,
  options: ContentBlobOptions = {}
): Promise<{ envelope: Bytes; reference: ContentBlobReference }> {
  return encryptContentBlobWith(key, kind, plaintext, options, systemRandom);
}

function acceptContent(reference: ContentBlobReference) {
  return (header: EnvelopeHeader): void => {
    if (header.class !== 'content') mismatch('class');
    if (header.blobId !== reference.blobId) mismatch('blobId');
    if (header.kind !== reference.kind) mismatch('kind');
    if (header.plaintextLength !== reference.plaintextLength) {
      mismatch('plaintextLength');
    }
  };
}

function checkReference(reference: ContentBlobReference): void {
  if (
    !isEnvelopeId(reference?.blobId) ||
    !CONTENT_BLOB_KINDS.includes(reference.kind) ||
    !(reference.key instanceof Uint8Array) ||
    reference.key.byteLength !== KEY_BYTES ||
    !(reference.ciphertextHash instanceof Uint8Array) ||
    reference.ciphertextHash.byteLength !== HASH_BYTES ||
    !isUint(reference.plaintextLength, Number.MAX_SAFE_INTEGER)
  ) {
    throw new E2eeError('invalid-argument', 'Not a content blob reference');
  }
}

/** An incremental reader that checks the blob against its reference. */
export function createContentBlobReader(
  reference: ContentBlobReference,
  options: ReadOptions = {}
): EnvelopeReader<ContentBlobHeader> {
  checkReference(reference);
  // The header check runs after awaits: hold the fields as checked now.
  const checked = { ...reference };
  return new EnvelopeReader<ContentBlobHeader>(
    checked.key,
    acceptContent(checked),
    checked.ciphertextHash,
    options
  );
}

/** Decrypts a content blob, refusing one that is not the referenced blob. */
export async function decryptContentBlob(
  reference: ContentBlobReference,
  envelope: Uint8Array,
  options: ReadOptions = {}
): Promise<Bytes> {
  const reader = createContentBlobReader(reference, options);
  return (
    await readWhole(
      reader,
      envelope,
      (header) => header.plaintextLength,
      options.maxPlaintextBytes
    )
  ).plaintext;
}

/**
 * Checks that a project envelope's header lists exactly the blobs its body
 * carries references for, so neither can name a blob the other omits.
 */
export function checkBlobReferences(
  header: ProjectEnvelopeHeader,
  references: readonly ContentBlobReference[]
): void {
  const listed = new Set(header.blobIds);
  const referenced = new Set(references.map((reference) => reference.blobId));
  if (
    referenced.size !== references.length ||
    listed.size !== referenced.size ||
    [...listed].some((id) => !referenced.has(id))
  ) {
    throw new E2eeError(
      'context-mismatch',
      'Header blob ids and body references disagree'
    );
  }
}

/** A JSON-safe reference for the encrypted document body. */
export interface ContentBlobReferenceJson {
  readonly blobId: string;
  readonly kind: ContentBlobKind;
  readonly key: string;
  readonly ciphertextHash: string;
  readonly plaintextLength: number;
}

export function contentBlobReferenceToJson(
  reference: ContentBlobReference
): ContentBlobReferenceJson {
  checkReference(reference);
  return {
    blobId: reference.blobId,
    kind: reference.kind,
    key: toBase64Url(reference.key),
    ciphertextHash: toBase64Url(reference.ciphertextHash),
    plaintextLength: reference.plaintextLength
  };
}

export function contentBlobReferenceFromJson(
  value: unknown
): ContentBlobReference {
  const record = (
    typeof value === 'object' && value !== null ? value : {}
  ) as Record<string, unknown>;
  // Lengths are checked before decoding: an untrusted reference with huge
  // strings is refused without decoding them.
  const key = fromBase64Url(record.key as string, KEY_BYTES);
  const ciphertextHash = fromBase64Url(
    record.ciphertextHash as string,
    HASH_BYTES
  );
  const reference = {
    blobId: record.blobId,
    kind: record.kind,
    key,
    ciphertextHash,
    plaintextLength: record.plaintextLength
  } as ContentBlobReference;
  if (
    !isUint(reference.plaintextLength, Number.MAX_SAFE_INTEGER) ||
    !isEnvelopeId(reference.blobId) ||
    !CONTENT_BLOB_KINDS.includes(reference.kind) ||
    key.byteLength !== KEY_BYTES ||
    ciphertextHash.byteLength !== HASH_BYTES
  ) {
    throw new E2eeError('malformed', 'Not a content blob reference');
  }
  return reference;
}

// --- Structure check ------------------------------------------------------

export interface EnvelopeShape extends EnvelopePrefix {
  readonly chunkCount: number;
  /** Payload bytes (compressed size when the header says gzip). */
  readonly payloadLength: number;
}

/**
 * Checks either envelope class without a key: the prefix parses, the
 * body splits into whole chunks, and the payload is no larger than the
 * header's kind, compression and declared size allow (`limit-exceeded`).
 * This is all a server can verify; the header is unauthenticated until a
 * key holder decrypts it.
 */
export function parseEnvelope(envelope: Uint8Array): EnvelopeShape {
  const length = envelopePrefixLength(envelope);
  if (length === null || envelope.byteLength < length) {
    throw new E2eeError('malformed', 'Envelope ends inside its header');
  }
  const prefix = decodeEnvelopePrefix(envelope.subarray(0, length));
  const body = envelope.byteLength - length;
  const cipherSize = prefix.header.chunkSize + GCM_TAG_BYTES;
  const remainder = body % cipherSize;
  if (body < GCM_TAG_BYTES || (remainder !== 0 && remainder < GCM_TAG_BYTES)) {
    throw new E2eeError(
      'malformed',
      'Envelope body is not a whole number of chunks'
    );
  }
  const chunkCount = Math.floor(body / cipherSize) + (remainder === 0 ? 0 : 1);
  if (chunkCount - 1 > MAX_CHUNK_INDEX) {
    throw new E2eeError('limit-exceeded', 'Envelope has too many chunks');
  }
  const payloadLength = body - chunkCount * GCM_TAG_BYTES;
  // Refuse a body larger than its header can produce before anyone hashes
  // or decrypts it: signature and chain checks hash the whole envelope.
  const bound = payloadBound(prefix.header);
  if (payloadLength > bound) {
    throw new E2eeError(
      'limit-exceeded',
      `Envelope payload is ${payloadLength} bytes; its header allows ${bound}`
    );
  }
  return { ...prefix, chunkCount, payloadLength };
}

// --- Streams (content blobs) ----------------------------------------------

export interface ContentBlobEncryptStream {
  readonly envelope: ReadableStream<Bytes>;
  /** Resolves once the envelope stream has been read to its end. */
  readonly reference: Promise<ContentBlobReference>;
}

/** Streams plaintext into a content blob, compressing first unless told not to. */
export function encryptContentBlobStream(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  plaintext: ReadableStream<Bytes>,
  options: ContentBlobWriterOptions
): ContentBlobEncryptStream {
  const compression = options.compression ?? 'gzip';
  const declared = options.plaintextLength;
  // Before `pipeThrough` locks and starts the source: past that point a
  // setup failure would leave it running with no handle to cancel it.
  if (compression === 'gzip') requireCompressionStreams();
  let seen = 0;
  const counted = plaintext.pipeThrough(
    new TransformStream<Bytes, Bytes>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > declared) {
          throw new E2eeError(
            'invalid-argument',
            `Plaintext is longer than the declared ${declared} bytes`
          );
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (seen !== declared) {
          throw new E2eeError(
            'invalid-argument',
            `Plaintext is ${seen} bytes, not the declared ${declared}`
          );
        }
      }
    })
  );
  const payload = (
    compression === 'gzip' ? compressStream(counted) : counted
  ).getReader();
  let resolve!: (reference: ContentBlobReference) => void;
  let reject!: (error: unknown) => void;
  const reference = new Promise<ContentBlobReference>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  reference.catch(() => undefined);
  // Every way the envelope can end settles `reference`: finishing resolves
  // it; a writer or source error, or the consumer cancelling, rejects it.
  const fail = (error: unknown): E2eeError => {
    const typed =
      error instanceof E2eeError
        ? error
        : new E2eeError('aborted', 'The content blob stream did not finish', {
            cause: error
          });
    reject(typed);
    return typed;
  };
  let writer: EnvelopeWriter<ContentBlobHeader>;
  let finalEnqueued = false;
  let input: Bytes | null = null;
  let inputOffset = 0;
  const envelope = new ReadableStream<Bytes>({
    async start(controller) {
      try {
        writer = await createContentBlobWriter(key, kind, {
          ...options,
          compression
        });
        controller.enqueue(writer.prefix);
      } catch (error) {
        // A rejected start never runs `cancel`, so release the plaintext
        // source here or its producer is left locked and running.
        const typed = fail(error);
        await payload.cancel(typed).catch(() => undefined);
        throw typed;
      }
    },
    async pull(controller) {
      try {
        // The final chunk was enqueued on an earlier pull, and this pull
        // only runs once the consumer has read it: now the blob is complete
        // on the consumer's side, so the reference may resolve. A cancel
        // before that rejects it instead.
        if (finalEnqueued) {
          controller.close();
          resolve(contentBlobReference(writer));
          return;
        }
        // Read until something can be emitted: the writer holds a full
        // chunk back until it knows whether more follows, and a pull that
        // enqueues nothing would never be called again. Feed the writer one
        // chunk-size slice per step, so a large input chunk yields its
        // records a few at a time under backpressure.
        for (;;) {
          if (!input || inputOffset >= input.byteLength) {
            const next = await payload.read();
            if (next.done) {
              controller.enqueue(await writer.finish());
              finalEnqueued = true;
              return;
            }
            input = next.value;
            inputOffset = 0;
          }
          const step = writer.header.chunkSize;
          const slice = input.subarray(inputOffset, inputOffset + step);
          inputOffset += slice.byteLength;
          const out = await writer.write(slice);
          for (const chunk of out) controller.enqueue(chunk);
          if (out.length > 0) return;
        }
      } catch (error) {
        const typed = fail(error);
        await payload.cancel(typed).catch(() => undefined);
        throw typed;
      }
    },
    async cancel(reason) {
      fail(
        new E2eeError('aborted', 'The content blob stream was cancelled', {
          cause: reason
        })
      );
      await payload.cancel(reason).catch(() => undefined);
    }
  });
  return { envelope, reference };
}

function asTypedError(error: unknown): unknown {
  return error instanceof E2eeError
    ? error
    : new E2eeError('malformed', 'Envelope payload could not be read', {
        cause: error
      });
}

/**
 * Streams a content blob back into plaintext, inflated when the header says
 * gzip. The output is not confirmed until the stream closes without error:
 * truncation and a hash mismatch are reported at the end, after earlier
 * chunks were already delivered.
 */
export function decryptContentBlobStream(
  reference: ContentBlobReference,
  envelope: ReadableStream<Uint8Array>,
  options: ReadOptions = {}
): ReadableStream<Bytes> {
  const reader = createContentBlobReader(reference, options);
  // Read once, as just validated: the stream ends long after this returns,
  // and the caller's reference may have changed by then.
  const declared = reference.plaintextLength;
  const cap = plaintextCap({
    kind: reference.kind,
    compression: 'none',
    declaredLength: declared,
    maxPlaintextBytes: options.maxPlaintextBytes
  });
  // Push the envelope a record at a time, so one huge input chunk is
  // decrypted under backpressure rather than all at once.
  const envelopeReader = envelope.getReader();
  let input: Uint8Array | null = null;
  let inputOffset = 0;
  const payloadReader = new ReadableStream<Bytes>({
    async pull(controller) {
      try {
        for (;;) {
          if (!input || inputOffset >= input.byteLength) {
            const next = await envelopeReader.read();
            if (next.done) {
              for (const part of await reader.finish())
                controller.enqueue(part);
              controller.close();
              return;
            }
            input = next.value;
            inputOffset = 0;
          }
          const slice = input.subarray(
            inputOffset,
            inputOffset + reader.preferredPushBytes
          );
          inputOffset += slice.byteLength;
          const out = await reader.push(slice);
          for (const part of out) controller.enqueue(part);
          if (out.length > 0) return;
        }
      } catch (error) {
        // Release and cancel the source too: erroring this stream does not
        // run its cancel callback, which would leave the producer running.
        await envelopeReader.cancel(error).catch(() => undefined);
        throw error;
      }
    },
    cancel: (reason) => envelopeReader.cancel(reason)
  }).getReader();

  let source: ReadableStreamDefaultReader<Bytes> | null = null;
  let delivered = 0;
  return new ReadableStream<Bytes>({
    async pull(controller) {
      try {
        if (!source) {
          const first = await payloadReader.read();
          if (first.done) {
            throw new E2eeError('malformed', 'Envelope has no chunks');
          }
          const rest = new ReadableStream<Bytes>({
            start: (c) => c.enqueue(first.value),
            async pull(c) {
              const next = await payloadReader.read();
              if (next.done) c.close();
              else c.enqueue(next.value);
            },
            cancel: (reason) => payloadReader.cancel(reason)
          });
          source = (
            reader.header!.compression === 'gzip'
              ? decompressStream(rest)
              : rest
          ).getReader();
        }
        const next = await source.read();
        if (next.done) {
          checkDeclaredLength(delivered, declared);
          controller.close();
          return;
        }
        delivered += next.value.byteLength;
        if (delivered > cap) {
          throw new E2eeError(
            'limit-exceeded',
            `Plaintext is larger than the declared ${cap} bytes`
          );
        }
        controller.enqueue(next.value);
      } catch (error) {
        const typed = asTypedError(error);
        await (source ?? payloadReader).cancel(typed).catch(() => undefined);
        throw typed;
      }
    },
    cancel: (reason) => (source ?? payloadReader).cancel(reason)
  });
}
