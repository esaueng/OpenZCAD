import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { concatBytes, copyBytes, joinBytes, type Bytes } from './bytes';
import { gunzipBytes, gzipBytes } from './compression';
import {
  EnvelopeKey,
  MAX_READER_PUSH_BYTES,
  MAX_READER_PUSH_RECORDS,
  MAX_WRITER_WRITE_BYTES,
  MAX_WRITER_WRITE_RECORDS,
  checkBlobReferences,
  contentBlobReference,
  contentBlobReferenceFromJson,
  contentBlobReferenceToJson,
  createContentBlobReader,
  createContentBlobWriter,
  createContentBlobWriterWith,
  decryptContentBlob,
  decryptContentBlobStream,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptContentBlobStream,
  encryptContentBlobWith,
  encryptProjectEnvelope,
  encryptWithHeaderForTests,
  decodePayload,
  envelopeBodyLength,
  envelopeKeyFromBytes,
  parseEnvelope,
  parseEnvelopeShape,
  type ContentBlobReference,
  type PayloadLimits
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  COMPRESSIONS,
  CONTENT_BLOB_KINDS,
  ENVELOPE_MAGIC,
  MAX_ENVELOPE_CHUNKS,
  PLAINTEXT_CEILINGS,
  PROJECT_ENVELOPE_KINDS,
  encodeEnvelopePrefix,
  type ContentBlobHeader,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit
} from './header';
import { generateSigningKeyPair } from './keys';
import { verifyProjectEnvelopeSignature, verifyVersionChain } from './signing';
import { patternBytes, queuedRandom } from './test-support';
import { IDENTITY_UNLOCK_METHODS, UNLOCK_METHODS } from './wrap';

const CHUNK = 64;
const CIPHER_CHUNK = CHUNK + 16;

const HEADER: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'project-a',
  documentVersion: 7,
  previousVersionHash: patternBytes(32, 0xa0),
  epochBindingHash: patternBytes(32, 0xb0),
  schemaVersion: 23,
  keyEpoch: 2,
  blobIds: ['blob-1', 'blob-2'],
  compression: 'none',
  chunkSize: CHUNK
};

const text = (value: string): Bytes => new TextEncoder().encode(value);

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

/** Encrypts a project envelope under a fixed key so tests can reopen it. */
async function sealProject(
  plaintext: Uint8Array,
  header: Partial<ProjectEnvelopeHeaderInit> = {},
  keyBytes: Uint8Array = patternBytes(32, 0x00)
): Promise<Bytes> {
  return encryptProjectEnvelope(
    envelopeKeyFromBytes(keyBytes),
    { ...HEADER, ...header },
    plaintext
  );
}

function split(envelope: Uint8Array): { prefix: Bytes; chunks: Bytes[] } {
  const shape = parseEnvelope(envelope);
  const body = envelope.subarray(shape.prefix.byteLength);
  const chunks: Bytes[] = [];
  for (let at = 0; at < body.byteLength; at += CIPHER_CHUNK) {
    chunks.push(body.slice(at, at + CIPHER_CHUNK));
  }
  return { prefix: shape.prefix, chunks };
}

function stream(parts: readonly Uint8Array[]): ReadableStream<Bytes> {
  return new ReadableStream<Bytes>({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    }
  });
}

async function collect(readable: ReadableStream<Bytes>): Promise<Bytes> {
  const parts: Bytes[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(...parts);
    parts.push(value);
  }
}

const KEY = patternBytes(32, 0x00);

describe('project envelopes', () => {
  it('keeps V1 readable and gives V2 documents an immutable authenticated link-set hash', async () => {
    const plaintext = text('v2 document');
    const commitment = patternBytes(32, 0x73);
    const legacy = await sealProject(plaintext);
    expect(legacy[3]).toBe(1);
    const current = await sealProject(plaintext, {
      shareLinkSetHash: commitment
    });
    expect(current[3]).toBe(2);
    const header = parseEnvelope(current).header as ProjectEnvelopeHeader;
    expect(header.shareLinkSetHash).toEqual(commitment);
    header.shareLinkSetHash!.fill(0);
    expect(header.shareLinkSetHash).toEqual(commitment);
    await expect(decryptProjectEnvelope(KEY, current)).resolves.toMatchObject({
      plaintext
    });
    const altered = current.slice();
    altered[parseEnvelope(current).prefix.length - 1]! ^= 1;
    await expect(decryptProjectEnvelope(KEY, altered)).rejects.toBeInstanceOf(
      E2eeError
    );
    const downgraded = current.slice();
    downgraded[3] = 1;
    expect(() => parseEnvelope(downgraded)).toThrow(/trailing/);
    const truncated = current.slice(
      0,
      parseEnvelope(current).prefix.length - 1
    );
    expect(() => parseEnvelope(truncated)).toThrow();
    await rejectsWith(
      sealProject(plaintext, {
        kind: 'measurements',
        shareLinkSetHash: commitment
      }),
      'invalid-argument'
    );
  });
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK * 3, CHUNK * 3 + 10])(
    'round-trips %i bytes',
    async (length) => {
      const plaintext = patternBytes(length, 7);
      const envelope = await sealProject(plaintext);
      const shape = parseEnvelope(envelope);
      expect(shape.chunkCount).toBe(Math.max(1, Math.ceil(length / CHUNK)));
      expect(shape.payloadLength).toBe(length);
      expect(envelope.byteLength).toBe(
        shape.prefix.byteLength + envelopeBodyLength(length, CHUNK)
      );
      const opened = await decryptProjectEnvelope(KEY, envelope, {
        expect: {
          projectId: 'project-a',
          kind: 'document',
          keyEpoch: 2,
          documentVersion: 7,
          epochBindingHash: patternBytes(32, 0xb0)
        }
      });
      expect(opened.plaintext).toEqual(plaintext);
      expect(opened.header).toMatchObject({
        ...HEADER,
        class: 'project',
        previousVersionHash: patternBytes(32, 0xa0)
      });
    }
  );

  it('compresses by default before encrypting', async () => {
    const plaintext = text('{"features":[]}'.repeat(500));
    const key = EnvelopeKey.generate();
    const envelope = await encryptProjectEnvelope(
      key,
      {
        kind: 'measurements',
        projectId: 'p',
        documentVersion: 0,
        previousVersionHash: null,
        epochBindingHash: patternBytes(32),
        schemaVersion: 1,
        keyEpoch: 0
      },
      plaintext
    );
    const shape = parseEnvelope(envelope);
    expect(shape.header).toMatchObject({
      class: 'project',
      compression: 'gzip',
      chunkSize: 1024 * 1024,
      blobIds: []
    });
    expect(shape.payloadLength).toBeLessThan(plaintext.byteLength / 10);
    expect(
      (await decryptProjectEnvelope(key.bytes, envelope)).plaintext
    ).toEqual(plaintext);
  });

  it('an encoder refuses to reuse a key for a second envelope', async () => {
    const key = EnvelopeKey.generate();
    expect(key.used).toBe(false);
    await encryptProjectEnvelope(key, HEADER, text('first'));
    expect(key.used).toBe(true);
    await rejectsWith(
      encryptProjectEnvelope(key, HEADER, text('second')),
      'key-reused'
    );
    await rejectsWith(
      encryptContentBlob(key, 'thumbnail', text('second')),
      'key-reused'
    );
    await rejectsWith(
      createContentBlobWriter(key, 'thumbnail', { plaintextLength: 1 }),
      'key-reused'
    );
    await rejectsWith(
      encryptProjectEnvelope(
        patternBytes(32) as unknown as EnvelopeKey,
        HEADER,
        text('raw')
      ),
      'invalid-argument'
    );
  });

  it('refuses to construct a duplicate key outside the module', () => {
    // `private` is compile-time only; JavaScript callers can still reach
    // the constructor, and a duplicate would escape the reuse check.
    const key = EnvelopeKey.generate();
    const Ctor = EnvelopeKey as unknown as new (
      ...args: unknown[]
    ) => EnvelopeKey;
    for (const args of [
      [key.bytes],
      [Symbol('EnvelopeKey'), key.bytes],
      [undefined, key.bytes]
    ]) {
      let caught: unknown;
      try {
        new Ctor(...args);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(E2eeError);
      expect((caught as E2eeError).code).toBe('invalid-argument');
    }
  });

  it('a prefix over 1 KiB needs chunks at least as large as itself', async () => {
    // Every chunk's AAD carries the whole prefix: a big header over tiny
    // chunks would cost far more than the payload, so it is refused.
    const blobIds = Array.from(
      { length: 60 },
      (_, i) => `blob-${String(i).padStart(24, '0')}`
    );
    await rejectsWith(
      encryptProjectEnvelope(
        EnvelopeKey.generate(),
        { ...HEADER, blobIds, chunkSize: 64 },
        text('x')
      ),
      'limit-exceeded'
    );
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      { ...HEADER, blobIds, chunkSize: 4096 },
      text('x')
    );
    const { prefix } = split(envelope);
    expect(prefix.byteLength).toBeGreaterThan(1024);
    // A forged prefix claiming 64-byte chunks is refused on read too.
    const forged = new Uint8Array(prefix);
    new DataView(forged.buffer).setUint32(11, 64);
    expect(() => parseEnvelope(forged)).toThrow(
      expect.objectContaining({ code: 'limit-exceeded' })
    );
  });

  it('refuses to construct a writer outside the module', async () => {
    // A second writer under one AES-GCM key would restart chunk nonces at
    // zero, so the class itself must not be constructible by consumers.
    const writer = await createContentBlobWriter(
      EnvelopeKey.generate(),
      'export',
      { compression: 'none', chunkSize: CHUNK, plaintextLength: 1 }
    );
    const Ctor = writer.constructor as new (...args: unknown[]) => unknown;
    const key = await crypto.subtle.importKey(
      'raw',
      patternBytes(32),
      'AES-GCM',
      false,
      ['encrypt']
    );
    for (const args of [
      [writer.header, writer.prefix, key],
      [Symbol('EnvelopeWriter'), writer.header, writer.prefix, key]
    ]) {
      expect(() => new Ctor(...args)).toThrow(
        expect.objectContaining({ code: 'invalid-argument' })
      );
    }
  });

  it('every header field is authenticated', async () => {
    const envelope = await sealProject(patternBytes(CHUNK * 3 + 10, 5));
    const { chunks } = split(envelope);
    const original = parseEnvelope(envelope).header as ProjectEnvelopeHeader;
    const tampered: Partial<ProjectEnvelopeHeader>[] = [
      { projectId: 'project-b' },
      { kind: 'view-state' },
      { documentVersion: 8 },
      { previousVersionHash: patternBytes(32, 0xa1) },
      { previousVersionHash: null },
      { epochBindingHash: patternBytes(32, 0xb1) },
      { schemaVersion: 24 },
      { keyEpoch: 3 },
      { blobIds: ['blob-1'] },
      { blobIds: ['blob-2', 'blob-1'] },
      { compression: 'gzip' },
      { plaintextLength: original.plaintextLength + 1 },
      { plaintextLength: original.plaintextLength - 1 }
    ];
    for (const change of tampered) {
      const forged = concatBytes(
        encodeEnvelopePrefix({ ...original, ...change }),
        ...chunks
      );
      await rejectsWith(
        decryptProjectEnvelope(KEY, forged),
        'authentication-failed'
      );
    }
  });

  it('every flipped prefix byte is refused with a typed error', async () => {
    const envelope = await sealProject(patternBytes(100));
    const { prefix } = split(envelope);
    for (let at = 0; at < prefix.byteLength; at += 1) {
      const forged = new Uint8Array(envelope);
      forged[at]! ^= 0x01;
      await expect(decryptProjectEnvelope(KEY, forged)).rejects.toBeInstanceOf(
        E2eeError
      );
    }
  });

  it('a flipped ciphertext or tag byte, or the wrong key, fails', async () => {
    const envelope = await sealProject(patternBytes(CHUNK * 3 + 10, 5));
    const { prefix } = split(envelope);
    for (const at of [
      prefix.byteLength,
      prefix.byteLength + CHUNK + 15,
      envelope.byteLength - 1
    ]) {
      const forged = new Uint8Array(envelope);
      forged[at]! ^= 0x80;
      await rejectsWith(
        decryptProjectEnvelope(KEY, forged),
        'authentication-failed'
      );
    }
    await rejectsWith(
      decryptProjectEnvelope(patternBytes(32, 0x40), envelope),
      'authentication-failed'
    );
  });

  it('an authentic envelope from another epoch, version or roster is refused', async () => {
    const envelope = await sealProject(patternBytes(10));
    for (const expectation of [
      { keyEpoch: 3 },
      { projectId: 'project-b' },
      { kind: 'share-snapshot' as const },
      { documentVersion: 6 },
      { schemaVersion: 22 },
      { previousVersionHash: null },
      { previousVersionHash: patternBytes(32, 0xa1) },
      { epochBindingHash: patternBytes(32, 0xb1) }
    ]) {
      await rejectsWith(
        decryptProjectEnvelope(KEY, envelope, { expect: expectation }),
        'context-mismatch'
      );
    }
  });

  it('truncated, reordered, duplicated or extended chunks fail', async () => {
    const envelope = await sealProject(patternBytes(CHUNK * 3 + 10, 5));
    const { prefix, chunks } = split(envelope);
    expect(chunks).toHaveLength(4);
    const [c0, c1, c2, c3] = chunks as [Bytes, Bytes, Bytes, Bytes];
    const forgeries: [Bytes, E2eeErrorCode][] = [
      [concatBytes(prefix, c0, c1, c2), 'authentication-failed'],
      [concatBytes(prefix, c0, c2, c3), 'authentication-failed'],
      [concatBytes(prefix, c1, c0, c2, c3), 'authentication-failed'],
      [concatBytes(prefix, c0, c1, c1, c2, c3), 'authentication-failed'],
      [concatBytes(prefix, c0, c1, c2, c3, c3), 'authentication-failed'],
      [envelope.slice(0, envelope.byteLength - 5), 'authentication-failed'],
      [concatBytes(envelope, patternBytes(20)), 'authentication-failed'],
      [concatBytes(envelope, patternBytes(3)), 'authentication-failed'],
      [prefix, 'malformed'],
      [prefix.slice(0, prefix.byteLength - 1), 'malformed']
    ];
    for (const [forged, code] of forgeries) {
      await rejectsWith(decryptProjectEnvelope(KEY, forged), code);
    }
  });

  it('chunks do not move between envelopes, even under the same key bytes', async () => {
    // Keys are single-use, so this needs the test-only key factory.
    const a = split(await sealProject(patternBytes(200, 1)));
    const b = split(
      await sealProject(patternBytes(200, 1), { projectId: 'project-b' })
    );
    await rejectsWith(
      decryptProjectEnvelope(KEY, concatBytes(a.prefix, ...b.chunks)),
      'authentication-failed'
    );
    await rejectsWith(
      decryptProjectEnvelope(
        KEY,
        concatBytes(a.prefix, b.chunks[0]!, ...a.chunks.slice(1))
      ),
      'authentication-failed'
    );
  });

  it('refuses unknown versions, foreign files and the wrong class', async () => {
    const envelope = await sealProject(patternBytes(10));
    const future = new Uint8Array(envelope);
    future[3] = 3;
    await rejectsWith(
      decryptProjectEnvelope(KEY, future),
      'unsupported-version'
    );
    expect(() => parseEnvelope(future)).toThrow(E2eeError);
    await rejectsWith(
      decryptProjectEnvelope(KEY, await gzipBytes(text('{"legacy":true}'))),
      'malformed'
    );
    const blob = await encryptContentBlob(
      envelopeKeyFromBytes(KEY),
      'thumbnail',
      text('png')
    );
    await rejectsWith(
      decryptProjectEnvelope(KEY, blob.envelope),
      'context-mismatch'
    );
  });

  it('refuses a payload above maxPlaintextBytes, including a gzip bomb', async () => {
    const plain = await sealProject(patternBytes(500));
    await rejectsWith(
      decryptProjectEnvelope(KEY, plain, { maxPlaintextBytes: 100 }),
      'limit-exceeded'
    );
    const bomb = await sealProject(new Uint8Array(1_000_000), {
      compression: 'gzip',
      chunkSize: 4096
    });
    expect(parseEnvelope(bomb).payloadLength).toBeLessThan(5000);
    await rejectsWith(
      decryptProjectEnvelope(KEY, bomb, { maxPlaintextBytes: 10_000 }),
      'limit-exceeded'
    );
  });

  it('rejects invalid headers without consuming the key', async () => {
    const invalid: Partial<ProjectEnvelopeHeaderInit>[] = [
      { projectId: '' },
      { projectId: 'has space' },
      { projectId: 'x'.repeat(129) },
      { documentVersion: -1 },
      { documentVersion: 1.5 },
      { keyEpoch: 2 ** 32 },
      { previousVersionHash: patternBytes(31) },
      { epochBindingHash: patternBytes(31) },
      { chunkSize: 63 },
      { chunkSize: 16 * 1024 * 1024 + 1 },
      { blobIds: ['a', 'a'] },
      { kind: 'thumbnail' as never },
      { compression: 'brotli' as never }
    ];
    const key = EnvelopeKey.generate();
    for (const change of invalid) {
      await rejectsWith(
        encryptProjectEnvelope(key, { ...HEADER, ...change }, text('x')),
        'invalid-argument'
      );
    }
    expect(key.used).toBe(false);
    await rejectsWith(
      encryptProjectEnvelope(
        key,
        {
          ...HEADER,
          blobIds: Array.from({ length: 4097 }, (_, i) => `b${i}`)
        },
        text('x')
      ),
      'limit-exceeded'
    );
    await rejectsWith(
      decryptProjectEnvelope(patternBytes(16), await sealProject(text('x'))),
      'invalid-argument'
    );
  });
});

describe('decompression limits', () => {
  /** A hostile key holder's envelope: any header over any payload. */
  async function forged(
    payload: Uint8Array,
    change: Partial<ProjectEnvelopeHeader>
  ) {
    const key = patternBytes(32, 0x77);
    const header = {
      ...(parseEnvelope(await sealProject(text('x')))
        .header as ProjectEnvelopeHeader),
      chunkSize: 4096,
      ...change
    };
    return {
      key,
      envelope: (
        await encryptWithHeaderForTests(
          envelopeKeyFromBytes(key),
          header,
          payload
        )
      ).envelope
    };
  }

  it('records the exact plaintext size in the header', async () => {
    const plaintext = text('{"features":[]}'.repeat(200));
    const envelope = await sealProject(plaintext, { compression: 'gzip' });
    const { header } = parseEnvelope(envelope);
    expect(header).toMatchObject({ plaintextLength: plaintext.byteLength });
  });

  it('stops a compression bomb at the declared size', async () => {
    // 64 MiB of zeros gzips to about 64 KiB; the header claims 1 KiB.
    const bomb = await gzipBytes(new Uint8Array(64 * 1024 * 1024));
    expect(bomb.byteLength).toBeLessThan(100_000);
    const { key, envelope } = await forged(bomb, {
      compression: 'gzip',
      plaintextLength: 1024
    });
    await rejectsWith(decryptProjectEnvelope(key, envelope), 'limit-exceeded');
  });

  it('refuses an oversized one-shot body before buffering all of it', async () => {
    // The header declares 1 KiB, uncompressed; the body carries 64 records
    // of 4 KiB. The one-shot buffer is sized from the header, so the first
    // record already overflows it and the rest are never decrypted.
    const { key, envelope } = await forged(patternBytes(4096 * 64, 3), {
      plaintextLength: 1024
    });
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      await rejectsWith(
        decryptProjectEnvelope(key, envelope),
        'limit-exceeded'
      );
      expect(decrypt.mock.calls.length).toBeLessThan(4);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('refuses an oversized body before hashing it for signatures', async () => {
    const { envelope } = await forged(patternBytes(4096 * 64, 3), {
      plaintextLength: 1024
    });
    expect(() => parseEnvelope(envelope)).toThrow(
      expect.objectContaining({ code: 'limit-exceeded' })
    );
    const author = await generateSigningKeyPair();
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      await rejectsWith(
        verifyProjectEnvelopeSignature(
          author.publicKey,
          envelope,
          new Uint8Array(73).fill(1, 0, 1)
        ),
        'limit-exceeded'
      );
      await rejectsWith(verifyVersionChain([envelope]), 'limit-exceeded');
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('keeps the ceiling table immutable at runtime', () => {
    expect(Object.isFrozen(PLAINTEXT_CEILINGS)).toBe(true);
    expect(() => {
      (PLAINTEXT_CEILINGS as Record<string, number>).thumbnail =
        Number.MAX_SAFE_INTEGER;
    }).toThrow(TypeError);
    expect(PLAINTEXT_CEILINGS.thumbnail).toBe(512 * 1024);
    // The name tables assign wire codes by position.
    for (const table of [
      PROJECT_ENVELOPE_KINDS,
      CONTENT_BLOB_KINDS,
      COMPRESSIONS,
      ENVELOPE_MAGIC,
      UNLOCK_METHODS,
      IDENTITY_UNLOCK_METHODS
    ]) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(() => (table as unknown[]).reverse()).toThrow(TypeError);
    }
    expect(PROJECT_ENVELOPE_KINDS[0]).toBe('document');
  });

  it('appends project-info and key-archive without renumbering', async () => {
    // Wire codes are positions plus one; the first four never move.
    expect(PROJECT_ENVELOPE_KINDS).toEqual([
      'document',
      'measurements',
      'view-state',
      'share-snapshot',
      'project-info',
      'key-archive'
    ]);
    for (const [kind, code] of [
      ['document', 1],
      ['share-snapshot', 4],
      ['project-info', 5],
      ['key-archive', 6]
    ] as const) {
      const key = EnvelopeKey.generate();
      const keyBytes = key.bytes;
      const envelope = await encryptProjectEnvelope(
        key,
        { ...HEADER, kind, blobIds: [] },
        text('{}')
      );
      // "OZE" | version | u32 length | class | kind
      expect(envelope[9]).toBe(code);
      expect(parseEnvelope(envelope).header.kind).toBe(kind);
      const opened = await decryptProjectEnvelope(keyBytes, envelope, {
        expect: { kind }
      });
      expect(opened.plaintext).toEqual(text('{}'));
    }
    expect(PLAINTEXT_CEILINGS['project-info']).toBe(1024 * 1024);
    expect(PLAINTEXT_CEILINGS['key-archive']).toBe(1024 * 1024);
    for (const kind of ['project-info', 'key-archive'] as const) {
      await rejectsWith(
        encryptProjectEnvelope(
          EnvelopeKey.generate(),
          { ...HEADER, kind, blobIds: [] },
          new Uint8Array(PLAINTEXT_CEILINGS[kind] + 1)
        ),
        'limit-exceeded'
      );
    }
    // A seventh kind code is still unknown.
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      { ...HEADER, blobIds: [] },
      text('{}')
    );
    const unknown = new Uint8Array(envelope);
    unknown[9] = 7;
    expect(() => parseEnvelope(unknown)).toThrow(
      expect.objectContaining({ code: 'malformed' }) as unknown
    );
  });

  it('stops at the kind ceiling even when the header claims more', async () => {
    const big = await gzipBytes(
      new Uint8Array(PLAINTEXT_CEILINGS.document + 1)
    );
    const { key, envelope } = await forged(big, {
      compression: 'gzip',
      plaintextLength: PLAINTEXT_CEILINGS.document + 1
    });
    await rejectsWith(decryptProjectEnvelope(key, envelope), 'limit-exceeded');
    const small = await forged(await gzipBytes(new Uint8Array(1000)), {
      kind: 'view-state',
      compression: 'gzip',
      plaintextLength: PLAINTEXT_CEILINGS['view-state'] + 1
    });
    await rejectsWith(
      decryptProjectEnvelope(small.key, small.envelope),
      'limit-exceeded'
    );
  });

  it('fails when the plaintext is shorter than declared, compressed or not', async () => {
    for (const compression of ['gzip', 'none'] as const) {
      const body = new Uint8Array(1000);
      const { key, envelope } = await forged(
        compression === 'gzip' ? await gzipBytes(body) : body,
        { compression, plaintextLength: 1001 }
      );
      await rejectsWith(decryptProjectEnvelope(key, envelope), 'malformed');
    }
  });

  it('refuses to encrypt above the kind ceiling', async () => {
    await rejectsWith(
      encryptProjectEnvelope(
        EnvelopeKey.generate(),
        { ...HEADER, kind: 'measurements', compression: 'gzip' },
        new Uint8Array(PLAINTEXT_CEILINGS.measurements + 1)
      ),
      'limit-exceeded'
    );
    await rejectsWith(
      encryptContentBlob(
        EnvelopeKey.generate(),
        'thumbnail',
        new Uint8Array(PLAINTEXT_CEILINGS.thumbnail + 1)
      ),
      'limit-exceeded'
    );
  });

  it('decodePayload refuses unknown kinds and malformed limits', async () => {
    const gz = await gzipBytes(new Uint8Array(1000));
    for (const limits of [
      { kind: 'video', compression: 'gzip', declaredLength: 1000 },
      { kind: 'toString', compression: 'gzip', declaredLength: 1000 },
      { kind: 'document', compression: 'brotli', declaredLength: 1000 },
      { kind: 'document', compression: 'gzip', declaredLength: Number.NaN },
      { kind: 'document', compression: 'gzip', declaredLength: -1 }
    ]) {
      await rejectsWith(
        decodePayload(gz, limits as unknown as PayloadLimits),
        'invalid-argument'
      );
    }
  });

  it('decodePayload is the same bounded decode, exposed', async () => {
    const body = text('abc'.repeat(1000));
    const gz = await gzipBytes(body);
    expect(
      await decodePayload(gz, {
        kind: 'document',
        compression: 'gzip',
        declaredLength: body.byteLength
      })
    ).toEqual(body);
    await rejectsWith(
      decodePayload(gz, {
        kind: 'document',
        compression: 'gzip',
        declaredLength: 100
      }),
      'limit-exceeded'
    );
    await rejectsWith(
      decodePayload(gz, {
        kind: 'document',
        compression: 'gzip',
        declaredLength: body.byteLength,
        maxPlaintextBytes: 100
      }),
      'limit-exceeded'
    );
    // Empty deflate blocks inflate to nothing: a 2-byte declaration allows
    // 2 + 1 + 1024 bytes of gzip, and anything longer is refused before
    // decompression starts.
    const padded = new Uint8Array(10 + 13_000 * 5);
    padded.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    for (let i = 0; i < 13_000; i += 1) {
      padded.set([0, 0, 0, 0xff, 0xff], 10 + i * 5);
    }
    await rejectsWith(
      decodePayload(padded, {
        kind: 'thumbnail',
        compression: 'gzip',
        declaredLength: 2
      }),
      'limit-exceeded'
    );
  });

  it('matches the limits it mirrors, and never the 1 GiB upload reservation', async () => {
    const shared = await import('@openzcad/shared');
    expect(PLAINTEXT_CEILINGS.document).toBe(
      shared.MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    );
    expect(PLAINTEXT_CEILINGS['share-snapshot']).toBe(
      shared.MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    );
    expect(PLAINTEXT_CEILINGS.thumbnail).toBe(shared.MAX_THUMBNAIL_BYTES);
    // The app constants live in modules too heavy for this suite; read them.
    const appConstant = (file: string, name: string): number => {
      const source = readFileSync(
        new URL(`../../../apps/web/${file}`, import.meta.url),
        'utf8'
      );
      const match = new RegExp(`${name} = ([\\d\\s*]+);`).exec(source);
      if (!match) throw new Error(`${name} not found in ${file}`);
      return match[1]!
        .split('*')
        .reduce((product, factor) => product * Number(factor), 1);
    };
    const sourceLimit = shared.MAX_SOURCE_IMPORT_BYTES;
    expect(sourceLimit).toBe(128 * 1024 * 1024);
    expect(
      appConstant(
        'src/lib/exactSourceResolver.ts',
        'MAX_ARTIFACT_DOWNLOAD_BYTES'
      )
    ).toBe(sourceLimit);
    expect(
      appConstant(
        'worker/projectMeasurements.ts',
        'MAX_PROJECT_MEASUREMENT_BYTES'
      )
    ).toBe(PLAINTEXT_CEILINGS.measurements);
    for (const kind of ['import-source', 'mesh-payload', 'export'] as const) {
      expect(PLAINTEXT_CEILINGS[kind]).toBe(sourceLimit);
    }
    for (const ceiling of Object.values(PLAINTEXT_CEILINGS)) {
      expect(ceiling).toBeLessThan(shared.MAX_ARTIFACT_UPLOAD_BYTES);
    }
  });

  it('accepts gzip of incompressible data at the payload limit', async () => {
    const random = new Uint8Array(200_000);
    for (let at = 0; at < random.length; at += 65_536) {
      crypto.getRandomValues(random.subarray(at, at + 65_536));
    }
    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'export',
      random
    );
    expect(parseEnvelope(envelope).payloadLength).toBeGreaterThan(200_000);
    expect(
      await decryptContentBlob(reference, envelope, {
        maxPlaintextBytes: 200_000
      })
    ).toEqual(random);
  });

  it('refuses an import source that inflates past 128 MiB', async () => {
    const limit = PLAINTEXT_CEILINGS['import-source'];
    // 128 MiB + 1 of zeros gzips to about 130 KiB.
    const bomb = await gzipBytes(new Uint8Array(limit + 1));
    // An honest writer cannot even declare it.
    await rejectsWith(
      createContentBlobWriter(EnvelopeKey.generate(), 'import-source', {
        plaintextLength: limit + 1
      }),
      'limit-exceeded'
    );
    // A hostile one declares the ceiling and writes the bomb: inflation
    // stops the moment output passes the declared size.
    const key = envelopeKeyFromBytes(patternBytes(32, 0x21));
    const writer = await createContentBlobWriterWith(
      key,
      'import-source',
      { compression: 'gzip', chunkSize: 64 * 1024, plaintextLength: limit },
      queuedRandom(patternBytes(16, 0x31))
    );
    const envelope = concatBytes(
      writer.prefix,
      ...(await writer.write(bomb)),
      await writer.finish()
    );
    await rejectsWith(
      decryptContentBlob(contentBlobReference(writer), envelope),
      'limit-exceeded'
    );
  });
});

describe('content blobs', () => {
  const STEP = text('ISO-10303-21;\nHEADER;\n'.repeat(40));

  async function blob(
    plaintext: Uint8Array = STEP,
    chunkSize = CHUNK
  ): Promise<{ envelope: Bytes; reference: ContentBlobReference }> {
    return encryptContentBlob(
      EnvelopeKey.generate(),
      'import-source',
      plaintext,
      {
        compression: 'none',
        chunkSize
      }
    );
  }

  it('round-trips under a fresh random id, with no project in the header', async () => {
    const { envelope, reference } = await blob();
    const { header } = parseEnvelope(envelope);
    expect(header).toEqual({
      class: 'content',
      kind: 'import-source',
      blobId: reference.blobId,
      compression: 'none',
      chunkSize: CHUNK,
      plaintextLength: STEP.byteLength
    } satisfies ContentBlobHeader);
    expect(reference.blobId).toMatch(/^[0-9a-f]{32}$/);
    expect(reference.ciphertextHash.byteLength).toBe(32);
    expect(await decryptContentBlob(reference, envelope)).toEqual(STEP);
    const other = await blob();
    expect(other.reference.blobId).not.toBe(reference.blobId);
  });

  it('stores a lost blob again under its id with a fresh key', async () => {
    const first = await blob();
    const again = await encryptContentBlob(
      EnvelopeKey.generate(),
      'import-source',
      STEP,
      { compression: 'none', chunkSize: CHUNK, blobId: first.reference.blobId }
    );
    expect(again.reference.blobId).toBe(first.reference.blobId);
    expect(parseEnvelope(again.envelope).header).toMatchObject({
      blobId: first.reference.blobId
    });
    // A new key and so new ciphertext: the old reference does not open it.
    expect(again.reference.key).not.toEqual(first.reference.key);
    expect(again.reference.ciphertextHash).not.toEqual(
      first.reference.ciphertextHash
    );
    expect(await decryptContentBlob(again.reference, again.envelope)).toEqual(
      STEP
    );
    await expect(
      decryptContentBlob(first.reference, again.envelope)
    ).rejects.toThrow(E2eeError);
    await expect(
      encryptContentBlob(EnvelopeKey.generate(), 'import-source', STEP, {
        blobId: ''
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('checks a stored blob from its prefix and total length alone', async () => {
    const { envelope } = await blob(STEP, 64);
    const whole = parseEnvelope(envelope);
    const head = envelope.slice(0, whole.prefix.byteLength + 3);
    expect(parseEnvelopeShape(head, envelope.byteLength)).toEqual(whole);
    // A body cut inside a chunk's tag is caught by its length alone.
    expect(() =>
      parseEnvelopeShape(head, whole.prefix.byteLength + 64 + 16 + 5)
    ).toThrowError(expect.objectContaining({ code: 'malformed' }));
    // A body cut at a chunk boundary still parses: only an uncompressed
    // blob's payload length shows that (the Worker checks it), and only
    // the final chunk shows it to a reader.
    expect(
      parseEnvelopeShape(head, whole.prefix.byteLength + 64 + 16).payloadLength
    ).toBe(64);
    // A head without the whole prefix, or a length inside it, is refused.
    expect(() =>
      parseEnvelopeShape(envelope.slice(0, 9), envelope.byteLength)
    ).toThrowError(expect.objectContaining({ code: 'malformed' }));
    expect(() => parseEnvelopeShape(head, 5)).toThrowError(
      expect.objectContaining({ code: 'malformed' })
    );
    expect(() => parseEnvelopeShape(head, -1)).toThrowError(
      expect.objectContaining({ code: 'invalid-argument' })
    );
  });

  it('compresses by default and round-trips through JSON references', async () => {
    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'mesh-payload',
      STEP
    );
    expect(parseEnvelope(envelope).header.compression).toBe('gzip');
    const json = JSON.parse(
      JSON.stringify(contentBlobReferenceToJson(reference))
    ) as unknown;
    const restored = contentBlobReferenceFromJson(json);
    expect(restored).toEqual(reference);
    expect(await decryptContentBlob(restored, envelope)).toEqual(STEP);
    for (const bad of [
      null,
      { ...(json as object), key: 'AAAA' },
      { ...(json as object), kind: 'document' },
      { ...(json as object), ciphertextHash: '!!' }
    ]) {
      expect(() => contentBlobReferenceFromJson(bad)).toThrow(E2eeError);
    }
    // Oversized encodings are refused on length, before any decoding.
    const atob = vi.spyOn(globalThis, 'atob');
    try {
      for (const field of ['key', 'ciphertextHash']) {
        expect(() =>
          contentBlobReferenceFromJson({
            ...(json as object),
            [field]: 'A'.repeat(8 * 1024 * 1024)
          })
        ).toThrow(expect.objectContaining({ code: 'malformed' }));
      }
      // Only the valid 43-character field beside it is ever decoded.
      for (const [input] of atob.mock.calls) {
        expect(String(input).length).toBeLessThan(64);
      }
    } finally {
      atob.mockRestore();
    }
  });

  it('a blob swapped in from another blob id is refused', async () => {
    const a = await blob(STEP);
    const b = await blob(STEP);
    // B's bytes served for A's reference: wrong key and wrong hash.
    await rejectsWith(
      decryptContentBlob(a.reference, b.envelope),
      'authentication-failed'
    );
    // A's ciphertext relabelled with B's id: the header is in every AAD.
    const relabelled = concatBytes(
      encodeEnvelopePrefix({
        ...(parseEnvelope(a.envelope).header as ContentBlobHeader),
        blobId: b.reference.blobId
      }),
      a.envelope.subarray(parseEnvelope(a.envelope).prefix.byteLength)
    );
    await rejectsWith(
      decryptContentBlob(
        { ...a.reference, blobId: b.reference.blobId },
        relabelled
      ),
      'authentication-failed'
    );
    // A reference that names the wrong id or kind for an authentic blob.
    await rejectsWith(
      decryptContentBlob(
        { ...a.reference, blobId: b.reference.blobId },
        a.envelope
      ),
      'context-mismatch'
    );
  });

  it('a reference whose ciphertext hash does not match is refused', async () => {
    const { envelope, reference } = await blob();
    const wrongHash = new Uint8Array(reference.ciphertextHash);
    wrongHash[0]! ^= 1;
    await rejectsWith(
      decryptContentBlob({ ...reference, ciphertextHash: wrongHash }, envelope),
      'authentication-failed'
    );
    const reader = createContentBlobReader({
      ...reference,
      ciphertextHash: wrongHash
    });
    await reader.push(envelope);
    await rejectsWith(reader.finish(), 'authentication-failed');
  });

  it('a consumer that transfers the prefix it was handed cannot break later chunks', async () => {
    const plaintext = patternBytes(CHUNK * 3 + 5, 8);
    const encrypted = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'mesh-payload',
      stream([plaintext]),
      {
        compression: 'none',
        chunkSize: CHUNK,
        plaintextLength: plaintext.byteLength
      }
    );
    const reader = encrypted.envelope.getReader();
    const first = (await reader.read()).value!;
    const prefix = copyBytes(first);
    // As if posted to an upload worker: the buffer is detached here.
    structuredClone(first.buffer, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    const parts = [prefix];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    const reference = await encrypted.reference;
    expect(await decryptContentBlob(reference, joinBytes(parts))).toEqual(
      plaintext
    );
    // The writer's own prefix and header are not the consumer's to edit.
    const writer = await createContentBlobWriter(
      EnvelopeKey.generate(),
      'export',
      { compression: 'none', chunkSize: CHUNK, plaintextLength: 1 }
    );
    const canonical = writer.prefix;
    writer.prefix.fill(0);
    expect(writer.prefix).toEqual(canonical);
    expect(canonical.some((byte) => byte !== 0)).toBe(true);
    expect(Object.isFrozen(writer.header)).toBe(true);
  });

  it('byte-at-a-time writes and pushes copy each byte a bounded number of times', async () => {
    // One 64 KiB record fed a byte at a time: recopying the growing buffer
    // on every call would move about 2 GB here (and ~1 TB for a 1 MiB
    // record); the queue keeps the total linear in the input.
    const size = 64 * 1024;
    const plaintext = patternBytes(size + 10, 5);
    let copied = 0;
    const set = vi
      .spyOn(Uint8Array.prototype, 'set')
      .mockImplementation(function (
        this: Uint8Array,
        source: ArrayLike<number>,
        offset?: number
      ) {
        copied += source.length;
        Reflect.apply(Int8Array.prototype.set, this, [source, offset]);
      });
    try {
      const writer = await createContentBlobWriter(
        EnvelopeKey.generate(),
        'export',
        {
          compression: 'none',
          chunkSize: size,
          plaintextLength: plaintext.byteLength
        }
      );
      const parts = [writer.prefix];
      for (let at = 0; at < plaintext.byteLength; at += 1) {
        parts.push(...(await writer.write(plaintext.subarray(at, at + 1))));
      }
      parts.push(await writer.finish());
      expect(copied).toBeLessThan(plaintext.byteLength * 10);
      const envelope = joinBytes(parts);
      copied = 0;
      const reader = createContentBlobReader(contentBlobReference(writer));
      const out: Bytes[] = [];
      for (let at = 0; at < envelope.byteLength; at += 1) {
        out.push(...(await reader.push(envelope.subarray(at, at + 1))));
      }
      out.push(...(await reader.finish()));
      expect(copied).toBeLessThan(envelope.byteLength * 10);
      expect(joinBytes(out)).toEqual(plaintext);
    } finally {
      set.mockRestore();
    }
  });

  it('a direct reader refuses an uncompressed blob shorter than declared', async () => {
    const { envelope: base } = await blob(text('hi'));
    const header = parseEnvelope(base).header as ContentBlobHeader;
    // A hash-matching pair whose header claims more than the body holds.
    const { envelope, writer } = await encryptWithHeaderForTests(
      EnvelopeKey.generate(),
      {
        ...header,
        compression: 'none',
        chunkSize: CHUNK,
        plaintextLength: CHUNK * 2
      },
      patternBytes(CHUNK + 5, 4)
    );
    const reference = contentBlobReference(writer);
    const reader = createContentBlobReader(reference);
    for (let at = 0; at < envelope.byteLength;) {
      const slice = envelope.subarray(at, at + reader.preferredPushBytes);
      at += slice.byteLength;
      await reader.push(slice);
    }
    await rejectsWith(reader.finish(), 'malformed');
    await rejectsWith(decryptContentBlob(reference, envelope), 'malformed');
  });

  it('an authenticated reader header cannot be altered mid-read', async () => {
    const plaintext = patternBytes(CHUNK * 4 + 3, 9);
    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'export',
      plaintext,
      { compression: 'none', chunkSize: CHUNK }
    );
    const reader = createContentBlobReader(reference);
    const out: Bytes[] = [];
    let at = 0;
    while (at < envelope.byteLength) {
      const slice = envelope.subarray(at, at + reader.preferredPushBytes);
      at += slice.byteLength;
      out.push(...(await reader.push(slice)));
      const header = reader.header;
      if (header) {
        expect(Object.isFrozen(header)).toBe(true);
        expect(() => {
          (header as { chunkSize: number }).chunkSize = 64;
        }).toThrow(TypeError);
      }
    }
    out.push(...(await reader.finish()));
    expect(joinBytes(out)).toEqual(plaintext);
    expect(Object.isFrozen(parseEnvelope(envelope).header)).toBe(true);
  });

  it('checks the expectation as passed, even if it changes mid-call', async () => {
    const envelope = await sealProject(text('x'));
    const roster = new Uint8Array(HEADER.epochBindingHash);
    const expectation = { projectId: 'project-a', epochBindingHash: roster };
    const decrypting = decryptProjectEnvelope(KEY, envelope, {
      expect: expectation
    });
    expectation.projectId = 'project-b';
    roster.fill(0);
    expect((await decrypting).plaintext).toEqual(text('x'));
  });

  it('one-shot decrypts read the envelope as passed', async () => {
    const plaintext = patternBytes(CHUNK * 4 + 1, 7);
    const sealed = await sealProject(plaintext);
    const projectBuffer = new Uint8Array(sealed);
    const opening = decryptProjectEnvelope(KEY, projectBuffer);
    projectBuffer.fill(0);
    expect((await opening).plaintext).toEqual(plaintext);
    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'export',
      plaintext,
      { compression: 'none', chunkSize: CHUNK }
    );
    const blobBuffer = new Uint8Array(envelope);
    const reading = decryptContentBlob(reference, blobBuffer);
    // Transferring the buffer away detaches it here.
    structuredClone(blobBuffer.buffer, { transfer: [blobBuffer.buffer] });
    expect(await reading).toEqual(plaintext);
  });

  it(`refuses more than ${MAX_ENVELOPE_CHUNKS} chunks of plaintext`, async () => {
    // Each chunk is sequential WebCrypto work: 128 MiB in 64-byte chunks
    // would be millions of calls, so small chunks need small payloads.
    await rejectsWith(
      createContentBlobWriter(EnvelopeKey.generate(), 'export', {
        compression: 'none',
        chunkSize: 64,
        plaintextLength: 64 * MAX_ENVELOPE_CHUNKS + 1
      }),
      'limit-exceeded'
    );
    const writer = await createContentBlobWriter(
      EnvelopeKey.generate(),
      'export',
      {
        compression: 'none',
        chunkSize: 4096,
        plaintextLength: 64 * MAX_ENVELOPE_CHUNKS + 1
      }
    );
    // The same declaration read back with 64-byte chunks is refused too.
    const forged = writer.prefix;
    new DataView(forged.buffer).setUint32(11, 64);
    expect(() => parseEnvelope(forged)).toThrow(
      expect.objectContaining({ code: 'limit-exceeded' })
    );
  });

  it('encrypts the plaintext as it was when the call began', async () => {
    // Writer setup awaits key import: an edit to the caller's array by then
    // must not change what is sealed under a header built from its length.
    for (const compression of ['none', 'gzip'] as const) {
      const original = patternBytes(CHUNK * 3 + 7, 3);
      const edited = new Uint8Array(original);
      const sealing = sealProject(edited, { compression });
      edited.fill(0);
      expect(
        (await decryptProjectEnvelope(KEY, await sealing)).plaintext
      ).toEqual(original);
      const blobInput = new Uint8Array(original);
      const encrypting = encryptContentBlob(
        EnvelopeKey.generate(),
        'export',
        blobInput,
        { compression, chunkSize: CHUNK }
      );
      blobInput.fill(0);
      const { envelope, reference } = await encrypting;
      expect(await decryptContentBlob(reference, envelope)).toEqual(original);
    }
  });

  it('decoded header hashes cannot be rewritten through the header', async () => {
    const envelope = await sealProject(text('x'));
    const header = parseEnvelope(envelope).header as ProjectEnvelopeHeader;
    header.epochBindingHash.fill(0);
    header.previousVersionHash!.fill(0);
    expect(header.epochBindingHash).toEqual(HEADER.epochBindingHash);
    expect(header.previousVersionHash).toEqual(HEADER.previousVersionHash);
    // The authenticated header a decrypt returns behaves the same way.
    const { header: opened } = await decryptProjectEnvelope(KEY, envelope);
    opened.epochBindingHash.fill(0);
    expect(opened.epochBindingHash).toEqual(HEADER.epochBindingHash);
  });

  it('leaves the source unlocked when gzip is unavailable', () => {
    let cancelled = false;
    const source = new ReadableStream<Bytes>({
      cancel() {
        cancelled = true;
      }
    });
    vi.stubGlobal('CompressionStream', undefined);
    try {
      expect(() =>
        encryptContentBlobStream(EnvelopeKey.generate(), 'export', source, {
          compression: 'gzip',
          plaintextLength: 1
        })
      ).toThrow(expect.objectContaining({ code: 'unavailable' }));
    } finally {
      vi.unstubAllGlobals();
    }
    // Nothing locked or started it, so the caller can still cancel it.
    expect(source.locked).toBe(false);
    expect(cancelled).toBe(false);
  });

  it('a direct gzip writer stops at the payload readers would accept', async () => {
    // 100 declared bytes allow 100 + 1 + 1024 bytes of gzip payload; past
    // that every reader refuses the blob, so the writer stops sealing.
    const writer = await createContentBlobWriter(
      EnvelopeKey.generate(),
      'export',
      { compression: 'gzip', chunkSize: CHUNK, plaintextLength: 100 }
    );
    await writer.write(patternBytes(1125, 1));
    await rejectsWith(writer.write(patternBytes(1, 2)), 'limit-exceeded');
  });

  it('a direct writer call is bounded in bytes and records', async () => {
    const plaintext = patternBytes(64 * (MAX_WRITER_WRITE_RECORDS + 10), 7);
    const writer = await createContentBlobWriter(
      EnvelopeKey.generate(),
      'export',
      {
        compression: 'none',
        chunkSize: 64,
        plaintextLength: plaintext.byteLength
      }
    );
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    try {
      await rejectsWith(writer.write(plaintext), 'invalid-argument');
      await rejectsWith(
        writer.write(new Uint8Array(MAX_WRITER_WRITE_BYTES + 1)),
        'invalid-argument'
      );
      expect(encrypt).not.toHaveBeenCalled();
    } finally {
      encrypt.mockRestore();
    }
    // A refused write leaves the writer usable: slice and carry on.
    const parts = [writer.prefix];
    for (let at = 0; at < plaintext.byteLength; at += 64 * 512) {
      parts.push(
        ...(await writer.write(plaintext.subarray(at, at + 64 * 512)))
      );
    }
    parts.push(await writer.finish());
    expect(
      await decryptContentBlob(contentBlobReference(writer), joinBytes(parts))
    ).toEqual(plaintext);
  });

  it('a direct reader push is bounded in bytes and records', async () => {
    // Minimum-size records: an unbounded push would open every one of
    // them before returning.
    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'export',
      patternBytes(64 * (MAX_READER_PUSH_RECORDS + 10), 6),
      { compression: 'none', chunkSize: 64 }
    );
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      await rejectsWith(
        createContentBlobReader(reference).push(envelope),
        'invalid-argument'
      );
      expect(decrypt).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
    }
    await rejectsWith(
      createContentBlobReader(reference).push(
        new Uint8Array(MAX_READER_PUSH_BYTES + 1)
      ),
      'invalid-argument'
    );
    // Pushing preferredPushBytes at a time reads the same envelope.
    expect(await decryptContentBlob(reference, envelope)).toEqual(
      patternBytes(64 * (MAX_READER_PUSH_RECORDS + 10), 6)
    );
  });

  it('id and kind in the reference must match an authentic header', async () => {
    const key = envelopeKeyFromBytes(KEY);
    const { envelope, reference } = await encryptContentBlobWith(
      key,
      'thumbnail',
      text('png'),
      { compression: 'none' },
      queuedRandom(patternBytes(16, 0x10))
    );
    await rejectsWith(
      decryptContentBlob({ ...reference, kind: 'export' }, envelope),
      'context-mismatch'
    );
  });

  it('truncated, reordered or duplicated chunks fail', async () => {
    const { envelope, reference } = await blob(patternBytes(CHUNK * 3 + 10));
    const { prefix, chunks } = split(envelope);
    const [c0, c1, c2, c3] = chunks as [Bytes, Bytes, Bytes, Bytes];
    for (const forged of [
      concatBytes(prefix, c0, c1, c2),
      concatBytes(prefix, c1, c0, c2, c3),
      concatBytes(prefix, c0, c0, c1, c2, c3)
    ]) {
      await rejectsWith(
        decryptContentBlob(reference, forged),
        'authentication-failed'
      );
    }
  });

  it('a copied project carries blob ids and keys; blob bytes are copied verbatim', async () => {
    const shared = await blob();
    const reference = contentBlobReferenceToJson(shared.reference);
    for (const projectId of ['source', 'destination']) {
      const versionKey = EnvelopeKey.generate();
      const keyBytes = versionKey.bytes;
      const body = text(JSON.stringify({ blobs: [reference] }));
      const envelope = await encryptProjectEnvelope(
        versionKey,
        { ...HEADER, projectId, blobIds: [shared.reference.blobId] },
        body
      );
      const opened = await decryptProjectEnvelope(keyBytes, envelope);
      const { blobs } = JSON.parse(
        new TextDecoder().decode(opened.plaintext)
      ) as {
        blobs: unknown[];
      };
      const references = blobs.map(contentBlobReferenceFromJson);
      checkBlobReferences(opened.header, references);
      expect(
        await decryptContentBlob(
          references[0]!,
          new Uint8Array(shared.envelope)
        )
      ).toEqual(STEP);
    }
  });

  it('header blob ids must match the body references', async () => {
    const a = (await blob()).reference;
    const b = (await blob()).reference;
    const header = parseEnvelope(
      await sealProject(text('x'), { blobIds: [a.blobId] })
    ).header as ProjectEnvelopeHeader;
    checkBlobReferences(header, [a]);
    for (const references of [[], [b], [a, b], [a, a]]) {
      expect(() => checkBlobReferences(header, references)).toThrow(E2eeError);
    }
  });

  it('writer output equals the one-shot blob for any write slicing', async () => {
    const plaintext = patternBytes(CHUNK * 4 + 5, 3);
    const oneShot = await encryptContentBlobWith(
      envelopeKeyFromBytes(KEY),
      'export',
      plaintext,
      { compression: 'none', chunkSize: CHUNK },
      queuedRandom(patternBytes(16, 0x99))
    );
    for (const step of [1, 7, CHUNK, CHUNK + 1, 1000]) {
      const key = envelopeKeyFromBytes(KEY);
      const writer = await createContentBlobWriterWith(
        key,
        'export',
        {
          compression: 'none',
          chunkSize: CHUNK,
          plaintextLength: plaintext.byteLength
        },
        queuedRandom(patternBytes(16, 0x99))
      );
      expect(() => writer.ciphertextHash).toThrow(E2eeError);
      const parts: Bytes[] = [writer.prefix];
      for (let at = 0; at < plaintext.byteLength; at += step) {
        parts.push(...(await writer.write(plaintext.subarray(at, at + step))));
      }
      parts.push(await writer.finish());
      expect(concatBytes(...parts)).toEqual(oneShot.envelope);
      expect(contentBlobReference(writer)).toEqual(oneShot.reference);
      // The reference always carries the writer's own key.
      expect(contentBlobReference(writer).key).toEqual(key.bytes);
      expect(writer.encryptedLength(plaintext.byteLength)).toBe(
        oneShot.envelope.byteLength
      );
      await rejectsWith(writer.write(patternBytes(1)), 'invalid-argument');
    }
  });

  it('reader accepts the envelope one byte at a time', async () => {
    const plaintext = patternBytes(CHUNK * 2 + 3);
    const { envelope, reference } = await blob(plaintext);
    const reader = createContentBlobReader(reference);
    const out: Bytes[] = [];
    for (let at = 0; at < envelope.byteLength; at += 1) {
      out.push(...(await reader.push(envelope.subarray(at, at + 1))));
    }
    out.push(...(await reader.finish()));
    expect(concatBytes(...out)).toEqual(plaintext);
    expect(reader.header?.blobId).toBe(reference.blobId);
  });

  it('a failing envelope source is aborted, not malformed', async () => {
    const { envelope, reference } = await blob(patternBytes(CHUNK * 3, 2));
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(envelope.subarray(0, 40));
          return;
        }
        controller.error(new TypeError('network connection lost'));
      }
    });
    await rejectsWith(
      collect(decryptContentBlobStream(reference, failing)),
      'aborted'
    );
    // Corrupt bytes from a healthy source are still malformed or refused.
    const corrupt = new Uint8Array(envelope);
    corrupt[corrupt.byteLength - 1]! ^= 1;
    await rejectsWith(
      collect(decryptContentBlobStream(reference, stream([corrupt]))),
      'authentication-failed'
    );
  });

  it('a stream decrypt holds the reference as passed', async () => {
    const plaintext = patternBytes(CHUNK * 3 + 9, 6);
    for (const compression of ['none', 'gzip'] as const) {
      const { envelope, reference } = await encryptContentBlob(
        EnvelopeKey.generate(),
        'export',
        plaintext,
        { compression, chunkSize: CHUNK }
      );
      const passed = { ...reference };
      const decrypted = decryptContentBlobStream(passed, stream([envelope]));
      // Changed after the call returns, before the stream ends.
      Object.assign(passed, { plaintextLength: 1 });
      expect(await collect(decrypted)).toEqual(plaintext);
    }
  });

  it('streams in both directions, with and without gzip', async () => {
    const plaintext = patternBytes(CHUNK * 5 + 17, 1);
    for (const compression of ['none', 'gzip'] as const) {
      const encrypted = encryptContentBlobStream(
        EnvelopeKey.generate(),
        'mesh-payload',
        stream([plaintext.subarray(0, 100), plaintext.subarray(100)]),
        { compression, chunkSize: CHUNK, plaintextLength: plaintext.byteLength }
      );
      const envelope = await collect(encrypted.envelope);
      const reference = await encrypted.reference;
      expect(await decryptContentBlob(reference, envelope)).toEqual(plaintext);
      const decrypted = decryptContentBlobStream(
        reference,
        stream([envelope.subarray(0, 50), envelope.subarray(50)])
      );
      expect(await collect(decrypted)).toEqual(plaintext);
    }
  });

  it('a streamed blob that is truncated or swapped errors with a typed error', async () => {
    const { envelope, reference } = await blob(patternBytes(CHUNK * 3));
    const truncated = envelope.subarray(0, envelope.byteLength - CIPHER_CHUNK);
    await rejectsWith(
      collect(decryptContentBlobStream(reference, stream([truncated]))),
      'authentication-failed'
    );
    const wrongHash = { ...reference, ciphertextHash: patternBytes(32) };
    await rejectsWith(
      collect(decryptContentBlobStream(wrongHash, stream([envelope]))),
      'authentication-failed'
    );
  });

  it('releases the plaintext source when the stream cannot start', async () => {
    const key = EnvelopeKey.generate();
    await encryptContentBlob(key, 'export', patternBytes(10));
    let cancelled: unknown = null;
    const source = new ReadableStream<Bytes>({
      pull(controller) {
        controller.enqueue(patternBytes(CHUNK));
      },
      cancel(reason) {
        cancelled = reason;
      }
    });
    // The key was already used, so creating the writer fails in `start`.
    const encrypted = encryptContentBlobStream(key, 'export', source, {
      compression: 'none',
      chunkSize: CHUNK,
      plaintextLength: CHUNK
    });
    await rejectsWith(collect(encrypted.envelope), 'key-reused');
    await rejectsWith(encrypted.reference, 'key-reused');
    expect(cancelled).toBeInstanceOf(E2eeError);
  });

  it('resolves the reference only once the final chunk has been read', async () => {
    const plaintext = patternBytes(CHUNK * 3);
    const encrypted = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'export',
      stream([plaintext]),
      { compression: 'none', chunkSize: CHUNK, plaintextLength: CHUNK * 3 }
    );
    const reader = encrypted.envelope.getReader();
    // Prefix, then the two non-final records; the final one is now queued.
    for (let i = 0; i < 3; i += 1) await reader.read();
    let settled = false;
    void encrypted.reference.then(
      () => (settled = true),
      () => (settled = true)
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(settled).toBe(false);
    // Discarding the queued final chunk must not leave a usable reference.
    await reader.cancel('upload abandoned');
    await rejectsWith(encrypted.reference, 'aborted');
  });

  it('joins any number of chunks without spreading them', async () => {
    // Half a million parts: far more than an engine accepts as arguments.
    const parts = Array.from({ length: 500_000 }, () => Uint8Array.of(7));
    expect(joinBytes(parts).byteLength).toBe(500_000);
    // The one-shot paths build and read many-chunk envelopes the same way.
    const plaintext = patternBytes(CHUNK * 5_000, 1);
    const key = patternBytes(32, 0x51);
    const envelope = await sealProject(plaintext, { chunkSize: CHUNK }, key);
    expect(parseEnvelope(envelope).chunkCount).toBe(5_000);
    expect((await decryptProjectEnvelope(key, envelope)).plaintext).toEqual(
      plaintext
    );
  });

  it('settles the reference when the source fails or the consumer cancels', async () => {
    const failing = new ReadableStream<Bytes>({
      start(controller) {
        controller.enqueue(patternBytes(100));
      },
      pull(controller) {
        controller.error(new Error('disk read failed'));
      }
    });
    const broken = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'export',
      failing,
      { compression: 'none', chunkSize: CHUNK, plaintextLength: 1000 }
    );
    await rejectsWith(collect(broken.envelope), 'aborted');
    await rejectsWith(broken.reference, 'aborted');

    const endless = new ReadableStream<Bytes>({
      pull(controller) {
        controller.enqueue(patternBytes(CHUNK));
      }
    });
    const cancelled = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'export',
      endless,
      { compression: 'none', chunkSize: CHUNK, plaintextLength: 1_000_000 }
    );
    const reader = cancelled.envelope.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel('upload abandoned');
    await rejectsWith(cancelled.reference, 'aborted');
  });

  it('hashes many chunks with bounded state', async () => {
    // 3000 chunks: the old digest list was spread into one call per blob.
    const plaintext = patternBytes(CHUNK * 3000, 9);
    const { envelope, reference } = await blob(plaintext);
    expect(parseEnvelope(envelope).chunkCount).toBe(3000);
    expect(await decryptContentBlob(reference, envelope)).toEqual(plaintext);
  });

  it('a streamed blob must match its declared size, in and out', async () => {
    const plaintext = new Uint8Array(200_000);
    const encrypted = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'export',
      stream([plaintext]),
      { chunkSize: 4096, plaintextLength: plaintext.byteLength }
    );
    const envelope = await collect(encrypted.envelope);
    const reference = await encrypted.reference;
    expect(parseEnvelope(envelope).header.plaintextLength).toBe(200_000);
    expect(
      (await collect(decryptContentBlobStream(reference, stream([envelope]))))
        .byteLength
    ).toBe(200_000);
    // The encryptor refuses plaintext longer or shorter than declared.
    for (const declared of [199_999, 200_001]) {
      const wrong = encryptContentBlobStream(
        EnvelopeKey.generate(),
        'export',
        stream([plaintext]),
        { chunkSize: 4096, plaintextLength: declared }
      );
      await rejectsWith(collect(wrong.envelope), 'invalid-argument');
      await rejectsWith(wrong.reference, 'invalid-argument');
    }
    // A reference whose size disagrees with the authenticated header.
    await rejectsWith(
      collect(
        decryptContentBlobStream(
          { ...reference, plaintextLength: 10_000 },
          stream([envelope])
        )
      ),
      'context-mismatch'
    );
    // A caller limit below the declared size is refused before reading.
    expect(() =>
      decryptContentBlobStream(reference, stream([envelope]), {
        maxPlaintextBytes: 10_000
      })
    ).toThrow(expect.objectContaining({ code: 'limit-exceeded' }));
  });

  it('binds the declared size into every chunk and enforces it after inflation', async () => {
    const plaintext = patternBytes(CHUNK * 3 + 10, 2);
    const { envelope, reference } = await blob(plaintext);
    const { prefix } = split(envelope);
    const header = parseEnvelope(envelope).header as ContentBlobHeader;
    // Altering the size in the header breaks every chunk's AAD.
    const altered = concatBytes(
      encodeEnvelopePrefix({
        ...header,
        plaintextLength: header.plaintextLength + 1
      }),
      envelope.subarray(prefix.byteLength)
    );
    await rejectsWith(
      decryptContentBlob(
        { ...reference, plaintextLength: header.plaintextLength + 1 },
        altered
      ),
      'authentication-failed'
    );
    // A key holder who declares the wrong size: shorter or longer output fails.
    for (const [declared, code] of [
      [plaintext.byteLength + 7, 'malformed'],
      [plaintext.byteLength - 7, 'limit-exceeded']
    ] as const) {
      for (const compression of ['none', 'gzip'] as const) {
        const payload =
          compression === 'gzip' ? await gzipBytes(plaintext) : plaintext;
        const { envelope: forged, writer } = await encryptWithHeaderForTests(
          EnvelopeKey.generate(),
          { ...header, compression, plaintextLength: declared },
          payload
        );
        await rejectsWith(
          decryptContentBlob(contentBlobReference(writer), forged),
          code
        );
      }
    }
  });

  it('a stream holds a gzip payload to what its authenticated header allows', async () => {
    // A gzip header followed by 64 KB of empty stored deflate blocks: it
    // inflates to nothing, so only the payload bound can stop it early.
    const emptyBlocks = 13_000;
    const payload = new Uint8Array(10 + emptyBlocks * 5);
    payload.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    for (let i = 0; i < emptyBlocks; i += 1) {
      payload.set([0, 0, 0, 0xff, 0xff], 10 + i * 5);
    }
    const { envelope: base } = await blob(text('hi'));
    const header = parseEnvelope(base).header as ContentBlobHeader;
    const { envelope, writer } = await encryptWithHeaderForTests(
      EnvelopeKey.generate(),
      { ...header, compression: 'gzip', chunkSize: 4096, plaintextLength: 2 },
      payload
    );
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      await rejectsWith(
        collect(
          decryptContentBlobStream(
            contentBlobReference(writer),
            stream([envelope])
          )
        ),
        'limit-exceeded'
      );
      expect(decrypt.mock.calls.length).toBeLessThan(4);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('an uncompressed writer refuses a total other than the declared size', async () => {
    for (const written of [CHUNK - 1, CHUNK + 1]) {
      const writer = await createContentBlobWriter(
        EnvelopeKey.generate(),
        'export',
        { compression: 'none', chunkSize: CHUNK, plaintextLength: CHUNK }
      );
      if (written > CHUNK) {
        await rejectsWith(
          writer.write(patternBytes(written)),
          'invalid-argument'
        );
      } else {
        await writer.write(patternBytes(written));
        await rejectsWith(writer.finish(), 'invalid-argument');
      }
      // No reference can be produced for the refused blob.
      expect(() => contentBlobReference(writer)).toThrow(E2eeError);
    }
  });

  it('gunzipBytes refuses a limit that would disable the guard', async () => {
    const gz = await gzipBytes(new Uint8Array(1000));
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5]) {
      await rejectsWith(gunzipBytes(gz, bad), 'invalid-argument');
    }
    expect((await gunzipBytes(gz, 1000)).byteLength).toBe(1000);
  });

  it('streams one large input chunk a few records at a time', async () => {
    const records = 1000;
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');
    try {
      const encrypted = encryptContentBlobStream(
        EnvelopeKey.generate(),
        'export',
        stream([new Uint8Array(CHUNK * records)]),
        {
          compression: 'none',
          chunkSize: CHUNK,
          plaintextLength: CHUNK * records
        }
      );
      const reader = encrypted.envelope.getReader();
      await reader.read(); // prefix
      await reader.read(); // first record
      await reader.read();
      // Backpressure holds: only a handful of records are encrypted ahead.
      expect(encrypt.mock.calls.length).toBeLessThan(10);
      let count = 2;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        count += 1;
      }
      expect(count).toBe(records);
      expect(encrypt.mock.calls.length).toBe(records);
      await encrypted.reference;
    } finally {
      encrypt.mockRestore();
    }
  });

  it('decrypts one large envelope chunk a few records at a time', async () => {
    const records = 1000;
    const { envelope, reference } = await blob(
      patternBytes(CHUNK * records, 4)
    );
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
    try {
      const reader = decryptContentBlobStream(
        reference,
        stream([envelope])
      ).getReader();
      await reader.read();
      await reader.read();
      // Backpressure holds: only a handful of records are decrypted ahead.
      expect(decrypt.mock.calls.length).toBeLessThan(10);
      let total = 2 * CHUNK;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
      }
      expect(total).toBe(CHUNK * records);
      expect(decrypt.mock.calls.length).toBe(records);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('cancels the source envelope stream when decryption fails', async () => {
    const { envelope, reference } = await blob(patternBytes(CHUNK * 50));
    const tampered = new Uint8Array(envelope);
    tampered[parseEnvelope(envelope).prefix.byteLength]! ^= 1;
    let cancelled: unknown = null;
    let delivered = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Deliver the envelope once, then stay open like a slow network.
        if (!delivered) {
          delivered = true;
          controller.enqueue(tampered);
        }
      },
      cancel(reason) {
        cancelled = reason;
      }
    });
    await rejectsWith(
      collect(decryptContentBlobStream(reference, source)),
      'authentication-failed'
    );
    expect(cancelled).toBeInstanceOf(E2eeError);
  });

  it('validates the key of a content blob reference up front', async () => {
    const { reference } = await blob(patternBytes(10));
    for (const key of [patternBytes(31), 'AAAA', undefined]) {
      const bad = { ...reference, key } as unknown as ContentBlobReference;
      expect(() => contentBlobReferenceToJson(bad)).toThrow(
        expect.objectContaining({ code: 'invalid-argument' })
      );
      expect(() => createContentBlobReader(bad)).toThrow(
        expect.objectContaining({ code: 'invalid-argument' })
      );
    }
  });

  it('refuses an invalid caller limit instead of skipping the ceiling', async () => {
    const { envelope, reference } = await blob(patternBytes(100));
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await rejectsWith(
        decryptContentBlob(reference, envelope, { maxPlaintextBytes: bad }),
        'invalid-argument'
      );
      await rejectsWith(
        decryptProjectEnvelope(KEY, await sealProject(text('x')), {
          maxPlaintextBytes: bad
        }),
        'invalid-argument'
      );
      expect(() =>
        decryptContentBlobStream(reference, stream([envelope]), {
          maxPlaintextBytes: bad
        })
      ).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    }
  });
});
