/**
 * The decode worker's jobs (ADR-024, Decompression limits), kept free of any
 * worker or DOM API so they run, and are tested, in Node as well as in the
 * module Worker that wraps them (`../../worker/e2eeDecodeWorker.ts`).
 *
 * Every limit here is enforced while the bytes are produced, not after:
 *
 * - Decryption and inflation go through `@openzcad/crypto`, which stops the
 *   moment output passes the smaller of the header's declared plaintext size
 *   and the kind's ceiling (`limit-exceeded`), refuses a declared size above
 *   that ceiling before inflating anything, and fails unless the result is
 *   exactly the declared size (`malformed`).
 * - A project envelope's plaintext is read by its kind's body codec
 *   (`decodeProjectBody`), which checks lexical depth and size before
 *   `JSON.parse` allocates anything and refuses any field it does not
 *   expect; a document is then checked with `documentStructureError`.
 * - A content blob is buffered until its stream closes cleanly: only the
 *   final chunk and the ciphertext hash prove that nothing was cut off or
 *   swapped, so no part of it is handed out before that.
 *
 * Every refusal is an `E2eeError`, so the client can rebuild it by code.
 */
import {
  CONTENT_BLOB_KINDS,
  E2eeError,
  EnvelopeKey,
  encodeEncryptedDocumentBody,
  encryptProjectEnvelope,
  versionHash,
  shareLinkSetCommitment,
  PLAINTEXT_CEILINGS,
  PROJECT_ENVELOPE_KINDS,
  decryptContentBlobStream,
  decodeEncryptedDocumentBody,
  decodeKeyArchiveBody,
  decodeMeasurementsBody,
  decodeProjectInfoBody,
  decodeViewStateBody,
  decryptProjectEnvelope,
  type ContentBlobKind,
  type ContentBlobReference,
  type E2eeErrorCode,
  type EncryptedDocumentBody,
  type KeyArchiveBody,
  type MeasurementsBody,
  type ProjectEnvelopeExpectation,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit,
  type ProjectEnvelopeKind,
  type ProjectInfoBody,
  type ShareLinkSet,
  type ViewStateBody
} from '@openzcad/crypto';
import {
  JsonComplexityGuard,
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  documentStructureError
} from '@openzcad/shared';

/** Decrypt a project envelope of `kind` and parse its JSON body. */
export interface ProjectEnvelopeDecodeJob {
  readonly type: 'project-envelope';
  readonly kind: ProjectEnvelopeKind;
  /** The raw 32-byte version key, already unwrapped under the project key. */
  readonly versionKey: Uint8Array;
  readonly envelope: Uint8Array;
  /** Header fields the envelope must carry; `kind` is always enforced. */
  readonly expect?: Omit<ProjectEnvelopeExpectation, 'kind'>;
}

/** Stream-decrypt a content blob against the reference that authenticates it. */
export interface ContentBlobDecodeJob {
  readonly type: 'content-blob';
  readonly reference: ContentBlobReference;
  /** A `Blob` is streamed; prefer it for large blobs, since it is not copied. */
  readonly envelope: Blob | Uint8Array;
  /** `chunks`: transferable pieces of at most 1 MiB; `blob`: one Blob. */
  readonly output: 'chunks' | 'blob';
}

/**
 * Encode and encrypt a document version off the main thread: the body
 * codec, gzip and AES-GCM over a document of up to 24 MiB would otherwise
 * stall the page. The worker draws the fresh version key and returns it
 * with the envelope and its version hash; wrapping the key and signing the
 * envelope stay on the page, where the project and device keys are.
 */
export interface SealDocumentJob {
  readonly type: 'seal-document';
  /** The header; its `blobIds` are always derived from `blobs`. */
  readonly header: Omit<ProjectEnvelopeHeaderInit, 'blobIds' | 'shareLinkSetHash'>;
  readonly document: Readonly<Record<string, unknown>>;
  /** The content blobs the document names (ADR-024 content blobs). */
  readonly blobs?: readonly ContentBlobReference[];
  readonly revisionVersionHashes: ReadonlyMap<string, Uint8Array>;
  /**
   * The active share-link set the version carries (slice 5-10): present,
   * even empty, makes the body version 2.
   */
  readonly shareLinks?: ShareLinkSet;
}

export interface SealDocumentResult {
  readonly type: 'seal-document';
  readonly envelope: Uint8Array;
  readonly versionHash: Uint8Array;
  /** The raw 32-byte version key, to wrap under the project key. */
  readonly versionKey: Uint8Array;
}

/** Every body a project envelope's codec reads. */
export type ProjectEnvelopeBody =
  | EncryptedDocumentBody
  | ProjectInfoBody
  | KeyArchiveBody
  | MeasurementsBody
  | ViewStateBody;

export type DecodeJob =
  ProjectEnvelopeDecodeJob | ContentBlobDecodeJob | SealDocumentJob;

export interface ProjectEnvelopeDecodeResult {
  readonly type: 'project-envelope';
  readonly header: ProjectEnvelopeHeader;
  /** The body as its kind's codec read it (`decodeProjectBody`). */
  readonly value: ProjectEnvelopeBody;
}

export type ContentBlobDecodeResult =
  | {
      readonly type: 'content-blob';
      readonly byteLength: number;
      readonly chunks: Uint8Array[];
    }
  | {
      readonly type: 'content-blob';
      readonly byteLength: number;
      readonly blob: Blob;
    };

export type DecodeResult =
  ProjectEnvelopeDecodeResult | ContentBlobDecodeResult | SealDocumentResult;

/** A refusal as it crosses the worker boundary. */
export interface DecodeFailure {
  /** The `E2eeError` code, or `null` for an unexpected worker exception. */
  readonly code: E2eeErrorCode | null;
  readonly message: string;
}

export interface DecodeWorkerRequest {
  readonly id: number;
  readonly job: DecodeJob;
}

export type DecodeWorkerResponse =
  | { readonly id: number; readonly ok: true; readonly result: DecodeResult }
  | { readonly id: number; readonly ok: false; readonly error: DecodeFailure };

/** Size of each transferable piece a `chunks` content blob result carries. */
export const DECODED_CHUNK_BYTES = 1024 * 1024;
/** UTF-8 is decoded and guarded in slices of this many bytes. */
const TEXT_SLICE_BYTES = 64 * 1024;

/**
 * The plaintext ceiling for one kind: documents and share snapshots use
 * `MAX_CLOUD_PROJECT_DOCUMENT_BYTES`, everything else the crypto package's
 * per-kind ceiling (128 MiB for imported sources, mesh payloads and exports;
 * smaller for thumbnails, measurements and view state). The decrypt paths
 * also apply `PLAINTEXT_CEILINGS` themselves and take the smaller of the two.
 */
export function decodeCeiling(
  kind: ProjectEnvelopeKind | ContentBlobKind
): number {
  if (kind === 'document' || kind === 'share-snapshot') {
    return MAX_CLOUD_PROJECT_DOCUMENT_BYTES;
  }
  return PLAINTEXT_CEILINGS[kind];
}

/**
 * Decodes UTF-8 a slice at a time, feeding each slice to the lexical guard
 * before it is kept, then parses and runs the structural check on the result.
 */
export function parseGuardedJson(bytes: Uint8Array): unknown {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const guard = new JsonComplexityGuard();
  const parts: string[] = [];
  const take = (decode: () => string) => {
    let text: string;
    try {
      text = decode();
    } catch (cause) {
      throw new E2eeError('malformed', 'Payload is not valid UTF-8', { cause });
    }
    try {
      guard.consume(text);
    } catch (cause) {
      throw new E2eeError(
        'limit-exceeded',
        'Payload JSON exceeds the document depth or value limit',
        { cause }
      );
    }
    parts.push(text);
  };
  for (let at = 0; at < bytes.byteLength; at += TEXT_SLICE_BYTES) {
    const slice = bytes.subarray(at, at + TEXT_SLICE_BYTES);
    take(() => decoder.decode(slice, { stream: true }));
  }
  take(() => decoder.decode());
  let value: unknown;
  try {
    value = JSON.parse(parts.join(''));
  } catch (cause) {
    throw new E2eeError('malformed', 'Payload is not valid JSON', { cause });
  }
  const structure = documentStructureError(value);
  if (structure) throw new E2eeError('limit-exceeded', structure);
  return value;
}

/**
 * The body of a decrypted project envelope, read by its kind's codec
 * (`@openzcad/crypto` bodies): every field is checked and anything else is
 * refused, so `{}`, a non-canonical project info or key archive, or a body
 * whose blob references disagree with the header never reaches the caller.
 * Documents and share snapshots then get the shared structural check.
 * Measurements and view state carry an app record each (slice 4-7); the
 * page checks the record after this, as it checks a document.
 */
export function decodeProjectBody(
  kind: ProjectEnvelopeKind,
  header: ProjectEnvelopeHeader,
  plaintext: Uint8Array
): ProjectEnvelopeBody {
  switch (kind) {
    case 'document':
    case 'share-snapshot': {
      const body = decodeEncryptedDocumentBody(plaintext, header);
      const structure = documentStructureError(body.document);
      if (structure) throw new E2eeError('limit-exceeded', structure);
      return body;
    }
    case 'project-info':
      return decodeProjectInfoBody(plaintext, header);
    case 'key-archive':
      return decodeKeyArchiveBody(plaintext, header);
    case 'measurements':
      return decodeMeasurementsBody(plaintext, header);
    case 'view-state':
      return decodeViewStateBody(plaintext, header);
    default:
      throw new E2eeError(
        'invalid-argument',
        `${String(kind)} envelopes have no body codec`
      );
  }
}

export async function decodeProjectEnvelopeJob(
  job: ProjectEnvelopeDecodeJob
): Promise<ProjectEnvelopeDecodeResult> {
  if (!PROJECT_ENVELOPE_KINDS.includes(job?.kind)) {
    throw new E2eeError('invalid-argument', 'Unknown project envelope kind');
  }
  const { header, plaintext } = await decryptProjectEnvelope(
    job.versionKey,
    job.envelope,
    {
      expect: { ...job.expect, kind: job.kind },
      maxPlaintextBytes: decodeCeiling(job.kind)
    }
  );
  const value = decodeProjectBody(job.kind, header, plaintext);
  if (header.shareLinkSetHash) {
    const actual = await shareLinkSetCommitment(
      (value as EncryptedDocumentBody).shareLinks
    );
    if (!actual.every((byte, index) => byte === header.shareLinkSetHash![index])) {
      throw new E2eeError('malformed', 'Document link set differs from its signed commitment');
    }
  }
  return {
    type: 'project-envelope',
    header,
    value
  };
}

function envelopeStream(
  envelope: Blob | Uint8Array
): ReadableStream<Uint8Array> {
  if (envelope instanceof Uint8Array) {
    // The reader pushes a record at a time, however large this one chunk is.
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(envelope);
        controller.close();
      }
    });
  }
  if (typeof Blob === 'function' && envelope instanceof Blob) {
    return envelope.stream();
  }
  throw new E2eeError('invalid-argument', 'Envelope must be a Blob or bytes');
}

/**
 * Copies streamed output into fresh pieces of `DECODED_CHUNK_BYTES`, so each
 * piece owns its buffer (transferable without detaching a neighbour) and
 * nothing is allocated ahead of the bytes that actually arrived.
 */
class PieceCollector {
  readonly pieces: Uint8Array<ArrayBuffer>[] = [];
  private current: Uint8Array<ArrayBuffer> | null = null;
  private at = 0;
  length = 0;

  constructor(private readonly declared: number) {}

  add(bytes: Uint8Array): void {
    for (let offset = 0; offset < bytes.byteLength;) {
      if (!this.current) {
        this.current = new Uint8Array(
          Math.min(
            DECODED_CHUNK_BYTES,
            Math.max(1, this.declared - this.length)
          )
        );
        this.at = 0;
      }
      const take = Math.min(
        this.current.byteLength - this.at,
        bytes.byteLength - offset
      );
      this.current.set(bytes.subarray(offset, offset + take), this.at);
      this.at += take;
      offset += take;
      this.length += take;
      if (this.at === this.current.byteLength) this.flush();
    }
  }

  flush(): void {
    if (!this.current) return;
    this.pieces.push(
      this.at === this.current.byteLength
        ? this.current
        : this.current.slice(0, this.at)
    );
    this.current = null;
  }
}

export async function decodeContentBlobJob(
  job: ContentBlobDecodeJob
): Promise<ContentBlobDecodeResult> {
  if (!CONTENT_BLOB_KINDS.includes(job?.reference?.kind)) {
    throw new E2eeError('invalid-argument', 'Unknown content blob kind');
  }
  if (job.output !== 'chunks' && job.output !== 'blob') {
    throw new E2eeError('invalid-argument', 'Unknown content blob output');
  }
  const plaintext = decryptContentBlobStream(
    job.reference,
    envelopeStream(job.envelope),
    { maxPlaintextBytes: decodeCeiling(job.reference.kind) }
  ).getReader();
  const collector = new PieceCollector(job.reference.plaintextLength);
  try {
    for (;;) {
      const next = await plaintext.read();
      if (next.done) break;
      collector.add(next.value);
    }
  } finally {
    plaintext.releaseLock();
  }
  collector.flush();
  const byteLength = collector.length;
  return job.output === 'blob'
    ? { type: 'content-blob', byteLength, blob: new Blob(collector.pieces) }
    : { type: 'content-blob', byteLength, chunks: collector.pieces };
}

export async function sealDocumentJob(
  job: SealDocumentJob
): Promise<SealDocumentResult> {
  if (job?.header?.kind !== 'document') {
    throw new E2eeError('invalid-argument', 'Only documents are sealed here');
  }
  // The header names exactly the blobs the body references: derived here,
  // never assembled separately, and checked again by the body encoder
  // (`checkBlobReferences`).
  const blobs = [...(job.blobs ?? [])];
  const header: ProjectEnvelopeHeaderInit = {
    ...job.header,
    blobIds: blobs.map((reference) => reference.blobId)
  };
  const plaintext = encodeEncryptedDocumentBody(
    {
      document: job.document,
      blobs,
      revisionVersionHashes: job.revisionVersionHashes,
      ...(job.shareLinks ? { shareLinks: job.shareLinks } : {})
    },
    header
  );
  const key = EnvelopeKey.generate();
  const envelope = await encryptProjectEnvelope(key, {
    ...header,
    // Hash the encoded snapshot, so mutations during the digest await cannot
    // separate the signed commitment from the bytes encrypted below.
    shareLinkSetHash: await shareLinkSetCommitment(
      decodeEncryptedDocumentBody(plaintext, header).shareLinks
    )
  }, plaintext);
  return {
    type: 'seal-document',
    envelope,
    versionHash: await versionHash(envelope),
    versionKey: key.bytes
  };
}

export function runDecodeJob(job: DecodeJob): Promise<DecodeResult> {
  switch (job?.type) {
    case 'seal-document':
      return sealDocumentJob(job);
    case 'project-envelope':
      return decodeProjectEnvelopeJob(job);
    case 'content-blob':
      return decodeContentBlobJob(job);
    default:
      return Promise.reject(
        new E2eeError('invalid-argument', 'Unknown decode job')
      );
  }
}

/** The buffers a result can hand over without copying. */
export function decodeResultTransfer(result: DecodeResult): ArrayBuffer[] {
  if (result.type === 'seal-document') {
    return [result.envelope.buffer as ArrayBuffer];
  }
  if (result.type !== 'content-blob' || !('chunks' in result)) return [];
  return result.chunks.map((chunk) => chunk.buffer as ArrayBuffer);
}

export function describeDecodeFailure(error: unknown): DecodeFailure {
  if (error instanceof E2eeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: null,
    message:
      error instanceof Error && error.message
        ? error.message
        : 'The decode worker failed'
  };
}

/** Runs one request and builds the reply the worker posts. */
export async function handleDecodeRequest(
  request: DecodeWorkerRequest
): Promise<{ response: DecodeWorkerResponse; transfer: ArrayBuffer[] }> {
  const id = request?.id;
  try {
    const result = await runDecodeJob(request.job);
    return {
      response: { id, ok: true, result },
      transfer: decodeResultTransfer(result)
    };
  } catch (error) {
    return {
      response: { id, ok: false, error: describeDecodeFailure(error) },
      transfer: []
    };
  }
}
