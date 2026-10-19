import {
  ByteWriter,
  asBytes,
  concatBytes,
  copyBytes,
  equalBytes,
  fromBase64Url,
  isUint,
  label,
  toBase64Url,
  toHex,
  type Bytes
} from './bytes';
import {
  DEFAULT_MAX_PLAINTEXT_BYTES,
  compressStream,
  decompressStream,
  gunzipBytes,
  gzipBytes
} from './compression';
import { E2eeError } from './errors';
import {
  CONTENT_BLOB_KINDS,
  PLAINTEXT_CEILINGS,
  DEFAULT_CHUNK_SIZE,
  HASH_BYTES,
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
    createKey = (bytes) => new EnvelopeKey(copyBytes(bytes));
  }

  private constructor(bytes: Bytes) {
    if (bytes.byteLength !== KEY_BYTES) {
      throw new E2eeError('invalid-argument', 'Envelope keys are 32 bytes');
    }
    this.#bytes = bytes;
  }

  static generate(): EnvelopeKey {
    return new EnvelopeKey(systemRandom(KEY_BYTES));
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

/**
 * Incremental encryptor. Emit `prefix` first, then everything `write` and
 * `finish` return, in order. Chunk `i` always starts at
 * `prefix.length + i * (chunkSize + 16)`, so multipart part boundaries and
 * ranged reads need no alignment with chunks. A full chunk is held back
 * until the next write or `finish` shows whether it is the last.
 *
 * The writer encrypts the payload as given: when `header.compression` is
 * `gzip`, feed it gzip bytes (or use the stream helper).
 */
export class EnvelopeWriter<H extends EnvelopeHeader = EnvelopeHeader> {
  private pending: Bytes = new Uint8Array();
  private index = 0;
  private state: 'open' | 'busy' | 'closed' = 'open';
  private readonly hasher: CiphertextHasher | null;
  private hash: Bytes | null = null;

  constructor(
    readonly header: H,
    readonly prefix: Bytes,
    private readonly key: CryptoKey
  ) {
    this.hasher = header.class === 'content' ? new CiphertextHasher() : null;
    // Folded in before the first chunk, which awaits it.
    this.hasher?.add(prefix).catch(() => undefined);
  }

  /** Encrypts every chunk that is now known not to be the last. */
  async write(payload: Uint8Array): Promise<Bytes[]> {
    return this.exclusive(async () => {
      const size = this.header.chunkSize;
      const data = this.pending.byteLength
        ? concatBytes(this.pending, payload)
        : payload;
      const out: Bytes[] = [];
      let offset = 0;
      while (data.byteLength - offset > size) {
        out.push(await this.seal(data.subarray(offset, offset + size), false));
        offset += size;
      }
      this.pending = copyBytes(data.subarray(offset));
      return out;
    });
  }

  /** Encrypts the final chunk (possibly empty) and closes the writer. */
  async finish(): Promise<Bytes> {
    const last = await this.exclusive(async () => {
      const chunk = await this.seal(this.pending, true);
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
      this.prefix.byteLength +
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
      chunkAad(this.prefix, index),
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

async function createWriter<H extends EnvelopeHeader>(
  key: EnvelopeKey,
  header: H
): Promise<EnvelopeWriter<H>> {
  const prefix = encodeEnvelopePrefix(header);
  const raw = consumeKey(key);
  return new EnvelopeWriter(
    header,
    prefix,
    await importChunkKey(raw, 'encrypt')
  );
}

// --- Reader ---------------------------------------------------------------

export interface ReadOptions {
  /** Ceiling on the payload and on the decompressed plaintext. Default 1 GiB. */
  readonly maxPlaintextBytes?: number;
}

/**
 * Incremental decryptor. Push envelope bytes in any slicing; each call
 * returns the payload chunks that authenticated. Output is not complete
 * until `finish` succeeds: only then has the final-chunk nonce proved that
 * nothing was cut off the end, and for a content blob that its ciphertext
 * hash matches the reference. Any failure poisons the reader.
 */
export class EnvelopeReader<H extends EnvelopeHeader = EnvelopeHeader> {
  private buffered: Bytes = new Uint8Array();
  private parsed: EnvelopePrefix | null = null;
  private cryptoKey: CryptoKey | null = null;
  private index = 0;
  private produced = 0;
  private verified = false;
  private state: 'open' | 'busy' | 'closed' = 'open';
  private readonly hasher: CiphertextHasher | null;
  private readonly maxBytes: number;

  constructor(
    private readonly key: Uint8Array,
    private readonly accept: (header: EnvelopeHeader) => void,
    private readonly expectedHash: Uint8Array | null,
    options: ReadOptions = {}
  ) {
    this.hasher = expectedHash ? new CiphertextHasher() : null;
    this.maxBytes = options.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
  }

  /** The header, once the first chunk has authenticated it. */
  get header(): H | null {
    return this.verified && this.parsed ? (this.parsed.header as H) : null;
  }

  async push(bytes: Uint8Array): Promise<Bytes[]> {
    return this.exclusive(async () => {
      this.buffered = concatBytes(this.buffered, bytes);
      if (!this.parsed && !(await this.readPrefix())) return [];
      const cipherSize = this.parsed!.header.chunkSize + GCM_TAG_BYTES;
      const out: Bytes[] = [];
      let offset = 0;
      while (this.buffered.byteLength - offset > cipherSize) {
        out.push(
          await this.open(
            this.buffered.subarray(offset, offset + cipherSize),
            false
          )
        );
        offset += cipherSize;
      }
      this.buffered = copyBytes(this.buffered.subarray(offset));
      return out;
    });
  }

  /** Authenticates the final chunk; throws if anything was cut or swapped. */
  async finish(): Promise<Bytes[]> {
    const out = await this.exclusive(async () => {
      if (!this.parsed && !(await this.readPrefix())) {
        throw new E2eeError('malformed', 'Envelope ends inside its header');
      }
      if (this.buffered.byteLength < GCM_TAG_BYTES) {
        throw new E2eeError('malformed', 'Envelope ends without a final chunk');
      }
      const last = await this.open(this.buffered, true);
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
    const length = envelopePrefixLength(this.buffered);
    if (length === null || this.buffered.byteLength < length) return false;
    this.parsed = decodeEnvelopePrefix(this.buffered.subarray(0, length));
    await this.hasher?.add(this.parsed.prefix);
    this.buffered = this.buffered.subarray(length);
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
 * The plaintext cap for one payload: the smaller of its declared size, its
 * kind's ceiling and the caller's limit. A declared size above the ceiling
 * is refused before any decompression (`limit-exceeded`).
 */
export function plaintextCap(limits: PayloadLimits): number {
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
  const plaintext =
    limits.compression === 'gzip'
      ? await gunzipBytes(payload, cap)
      : asBytes(payload);
  checkDeclaredLength(plaintext.byteLength, limits.declaredLength);
  return plaintext;
}

async function readWhole<H extends EnvelopeHeader>(
  reader: EnvelopeReader<H>,
  envelope: Uint8Array,
  declaredLength: (header: H) => number,
  maxPlaintextBytes: number | undefined
): Promise<{ header: H; plaintext: Bytes }> {
  const parts = [...(await reader.push(envelope)), ...(await reader.finish())];
  const header = reader.header!;
  const plaintext = await decodePayload(concatBytes(...parts), {
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

function acceptProject(expect: ProjectEnvelopeExpectation) {
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
  const writer = await createWriter(key, header);
  const payload =
    writer.header.compression === 'gzip'
      ? await gzipBytes(plaintext)
      : plaintext;
  const chunks = await writer.write(payload);
  return concatBytes(writer.prefix, ...chunks, await writer.finish());
}

/**
 * @internal Tests only: encrypts `payload` as given (already compressed if
 * the header says so) under an arbitrary header, the way a hostile key
 * holder could, so decode limits can be exercised.
 */
export async function encryptWithHeaderForTests(
  key: EnvelopeKey,
  header: EnvelopeHeader,
  payload: Uint8Array
): Promise<Bytes> {
  const writer = await createWriter(key, header);
  const chunks = await writer.write(payload);
  return concatBytes(writer.prefix, ...chunks, await writer.finish());
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

/** @internal Tests inject the blob id source; production uses `createContentBlobWriter`. */
export async function createContentBlobWriterWith(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  options: ContentBlobOptions,
  random: RandomSource
): Promise<EnvelopeWriter<ContentBlobHeader>> {
  const header: ContentBlobHeader = {
    class: 'content',
    kind,
    blobId: toHex(random(BLOB_ID_BYTES)),
    compression: options.compression ?? 'gzip',
    chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE
  };
  checkHeader(header, 'invalid-argument');
  return createWriter(key, header);
}

/**
 * Starts a content blob under a fresh random id. After `finish`, build its
 * reference with `contentBlobReference(writer, key)`.
 */
export async function createContentBlobWriter(
  key: EnvelopeKey,
  kind: ContentBlobKind,
  options: ContentBlobOptions = {}
): Promise<EnvelopeWriter<ContentBlobHeader>> {
  return createContentBlobWriterWith(key, kind, options, systemRandom);
}

/**
 * The reference for a finished content blob writer. `plaintextLength` is the
 * size before any compression the caller applied.
 */
export function contentBlobReference(
  writer: EnvelopeWriter<ContentBlobHeader>,
  key: EnvelopeKey,
  plaintextLength: number
): ContentBlobReference {
  checkEncryptSize(writer.header.kind, plaintextLength);
  return {
    blobId: writer.header.blobId,
    kind: writer.header.kind,
    key: key.bytes,
    ciphertextHash: writer.ciphertextHash,
    plaintextLength
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
  checkEncryptSize(kind, plaintext.byteLength);
  const writer = await createContentBlobWriterWith(key, kind, options, random);
  const payload =
    writer.header.compression === 'gzip'
      ? await gzipBytes(plaintext)
      : plaintext;
  const chunks = await writer.write(payload);
  const envelope = concatBytes(writer.prefix, ...chunks, await writer.finish());
  return {
    envelope,
    reference: contentBlobReference(writer, key, plaintext.byteLength)
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
  };
}

function checkReference(reference: ContentBlobReference): void {
  if (
    !isEnvelopeId(reference?.blobId) ||
    !CONTENT_BLOB_KINDS.includes(reference.kind) ||
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
  return new EnvelopeReader<ContentBlobHeader>(
    reference.key,
    acceptContent(reference),
    reference.ciphertextHash,
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
      () => reference.plaintextLength,
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
  const key = fromBase64Url(record.key as string);
  const ciphertextHash = fromBase64Url(record.ciphertextHash as string);
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
 * Checks either envelope class without a key: the prefix parses and the
 * body splits into whole chunks. This is all a server can verify; the
 * header is unauthenticated until a key holder decrypts it.
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
  return {
    ...prefix,
    chunkCount,
    payloadLength: body - chunkCount * GCM_TAG_BYTES
  };
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
  options: ContentBlobOptions = {}
): ContentBlobEncryptStream {
  const compression = options.compression ?? 'gzip';
  let plaintextLength = 0;
  const counted = plaintext.pipeThrough(
    new TransformStream<Bytes, Bytes>({
      transform(chunk, controller) {
        plaintextLength += chunk.byteLength;
        checkEncryptSize(kind, plaintextLength);
        controller.enqueue(chunk);
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
  const envelope = new ReadableStream<Bytes>({
    async start(controller) {
      try {
        writer = await createContentBlobWriter(key, kind, {
          ...options,
          compression
        });
        controller.enqueue(writer.prefix);
      } catch (error) {
        throw fail(error);
      }
    },
    async pull(controller) {
      try {
        // Read until something can be emitted: the writer holds a full
        // chunk back until it knows whether more follows, and a pull that
        // enqueues nothing would never be called again.
        for (;;) {
          const next = await payload.read();
          if (next.done) {
            controller.enqueue(await writer.finish());
            controller.close();
            resolve(contentBlobReference(writer, key, plaintextLength));
            return;
          }
          const out = await writer.write(next.value);
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
  const cap = plaintextCap({
    kind: reference.kind,
    compression: 'none',
    declaredLength: reference.plaintextLength,
    maxPlaintextBytes: options.maxPlaintextBytes
  });
  const payloadReader = envelope
    .pipeThrough(
      new TransformStream<Uint8Array, Bytes>({
        async transform(chunk, controller) {
          for (const part of await reader.push(chunk)) controller.enqueue(part);
        },
        async flush(controller) {
          for (const part of await reader.finish()) controller.enqueue(part);
        }
      })
    )
    .getReader();

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
          checkDeclaredLength(delivered, reference.plaintextLength);
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
