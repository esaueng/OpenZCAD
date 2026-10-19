import { describe, expect, it } from 'vitest';
import { concatBytes, type Bytes } from './bytes';
import { gzipBytes } from './compression';
import {
  EnvelopeKey,
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
  type ContentBlobReference
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  PLAINTEXT_CEILINGS,
  encodeEnvelopePrefix,
  type ContentBlobHeader,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit
} from './header';
import { patternBytes, queuedRandom } from './test-support';

const CHUNK = 64;
const CIPHER_CHUNK = CHUNK + 16;

const HEADER: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'project-a',
  documentVersion: 7,
  previousVersionHash: patternBytes(32, 0xa0),
  rosterEntryHash: patternBytes(32, 0xb0),
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
          rosterEntryHash: patternBytes(32, 0xb0)
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
        rosterEntryHash: patternBytes(32),
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
    await rejectsWith(createContentBlobWriter(key, 'thumbnail'), 'key-reused');
    await rejectsWith(
      encryptProjectEnvelope(
        patternBytes(32) as unknown as EnvelopeKey,
        HEADER,
        text('raw')
      ),
      'invalid-argument'
    );
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
      { rosterEntryHash: patternBytes(32, 0xb1) },
      { schemaVersion: 24 },
      { keyEpoch: 3 },
      { blobIds: ['blob-1'] },
      { blobIds: ['blob-2', 'blob-1'] },
      { compression: 'gzip' }
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
      { rosterEntryHash: patternBytes(32, 0xb1) }
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
    future[3] = 2;
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
      { rosterEntryHash: patternBytes(31) },
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
      envelope: await encryptWithHeaderForTests(
        envelopeKeyFromBytes(key),
        header,
        payload
      )
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
  });

  it('matches the shared server limits', async () => {
    const shared = await import('@openzcad/shared');
    expect(PLAINTEXT_CEILINGS.document).toBe(
      shared.MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    );
    expect(PLAINTEXT_CEILINGS['import-source']).toBe(
      shared.MAX_ARTIFACT_UPLOAD_BYTES
    );
    expect(PLAINTEXT_CEILINGS.export).toBe(shared.MAX_ARTIFACT_UPLOAD_BYTES);
    expect(PLAINTEXT_CEILINGS.thumbnail).toBe(shared.MAX_THUMBNAIL_BYTES);
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
      chunkSize: CHUNK
    } satisfies ContentBlobHeader);
    expect(reference.blobId).toMatch(/^[0-9a-f]{32}$/);
    expect(reference.ciphertextHash.byteLength).toBe(32);
    expect(await decryptContentBlob(reference, envelope)).toEqual(STEP);
    const other = await blob();
    expect(other.reference.blobId).not.toBe(reference.blobId);
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
        { compression: 'none', chunkSize: CHUNK },
        queuedRandom(patternBytes(16, 0x99))
      );
      expect(() => writer.ciphertextHash).toThrow(E2eeError);
      const parts: Bytes[] = [writer.prefix];
      for (let at = 0; at < plaintext.byteLength; at += step) {
        parts.push(...(await writer.write(plaintext.subarray(at, at + step))));
      }
      parts.push(await writer.finish());
      expect(concatBytes(...parts)).toEqual(oneShot.envelope);
      expect(contentBlobReference(writer, key, plaintext.byteLength)).toEqual(
        oneShot.reference
      );
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

  it('streams in both directions, with and without gzip', async () => {
    const plaintext = patternBytes(CHUNK * 5 + 17, 1);
    for (const compression of ['none', 'gzip'] as const) {
      const encrypted = encryptContentBlobStream(
        EnvelopeKey.generate(),
        'mesh-payload',
        stream([plaintext.subarray(0, 100), plaintext.subarray(100)]),
        { compression, chunkSize: CHUNK }
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

  it('a streamed blob stops at its declared size, and must reach it exactly', async () => {
    const encrypted = encryptContentBlobStream(
      EnvelopeKey.generate(),
      'export',
      stream([new Uint8Array(200_000)]),
      { chunkSize: 4096 }
    );
    const envelope = await collect(encrypted.envelope);
    const reference = await encrypted.reference;
    expect(reference.plaintextLength).toBe(200_000);
    expect(
      (await collect(decryptContentBlobStream(reference, stream([envelope]))))
        .byteLength
    ).toBe(200_000);
    // A reference that declares less: inflation stops at the declared size.
    await rejectsWith(
      collect(
        decryptContentBlobStream(
          { ...reference, plaintextLength: 10_000 },
          stream([envelope])
        )
      ),
      'limit-exceeded'
    );
    // One that declares more fails once the stream ends short.
    await rejectsWith(
      collect(
        decryptContentBlobStream(
          { ...reference, plaintextLength: 200_001 },
          stream([envelope])
        )
      ),
      'malformed'
    );
    // A caller limit below the declared size is refused before reading.
    expect(() =>
      decryptContentBlobStream(reference, stream([envelope]), {
        maxPlaintextBytes: 10_000
      })
    ).toThrow(expect.objectContaining({ code: 'limit-exceeded' }));
  });
});
