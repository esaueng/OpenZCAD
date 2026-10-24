import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  E2eeError,
  EnvelopeKey,
  PLAINTEXT_CEILINGS,
  encodeEncryptedDocumentBody,
  encodeKeyArchiveBody,
  encodeProjectInfoBody,
  encryptContentBlob,
  encryptProjectEnvelope,
  gzipBytes,
  parseEnvelope,
  type ContentBlobReference,
  type E2eeErrorCode,
  type ProjectEnvelopeHeader,
  type ProjectEnvelopeHeaderInit
} from '@openzcad/crypto';
import { MAX_CLOUD_PROJECT_DOCUMENT_BYTES } from '@openzcad/shared';
import {
  contentBlobReference,
  createContentBlobWriterWith,
  encryptWithHeaderForTests,
  envelopeKeyFromBytes
} from '../packages/crypto/src/envelope';
import {
  patternBytes,
  queuedRandom
} from '../packages/crypto/src/test-support';
import {
  DECODED_CHUNK_BYTES,
  decodeCeiling,
  handleDecodeRequest,
  parseGuardedJson,
  runDecodeJob,
  type ContentBlobDecodeResult,
  type ProjectEnvelopeDecodeResult
} from '../apps/web/src/lib/e2ee/decodeJobs';

const HEADER: ProjectEnvelopeHeaderInit = {
  kind: 'document',
  projectId: 'project-decode',
  documentVersion: 3,
  previousVersionHash: null,
  epochBindingHash: patternBytes(32, 0xb0),
  schemaVersion: 1,
  keyEpoch: 1
};

const MIB = 1024 * 1024;
const encode = (text: string) => new TextEncoder().encode(text);

afterEach(() => vi.restoreAllMocks());

/** Deep equality on megabytes of typed array is far too slow for a unit test. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/** Whether `JSON.parse` saw this text (the spy also sees source maps). */
function parsedText(parse: { mock: { calls: unknown[][] } }, text: string) {
  return parse.mock.calls.some(([input]) => input === text);
}

async function rejectsWith(
  promise: Promise<unknown>,
  ...codes: E2eeErrorCode[]
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && codes.includes(error.code)
  );
}

async function sealed(
  plaintext: Uint8Array,
  header: Partial<ProjectEnvelopeHeaderInit> = {}
): Promise<{ versionKey: Uint8Array; envelope: Uint8Array }> {
  const key = EnvelopeKey.generate();
  const versionKey = key.bytes;
  const envelope = await encryptProjectEnvelope(
    key,
    { ...HEADER, ...header },
    plaintext
  );
  return { versionKey, envelope };
}

/** A hostile key holder's project envelope: any header over any payload. */
async function forged(
  payload: Uint8Array,
  change: Partial<ProjectEnvelopeHeader>
): Promise<{ versionKey: Uint8Array; envelope: Uint8Array }> {
  const versionKey = patternBytes(32, 0x5a);
  const header = {
    ...(parseEnvelope((await sealed(encode('{}'))).envelope)
      .header as ProjectEnvelopeHeader),
    chunkSize: 64 * 1024,
    ...change
  };
  const { envelope } = await encryptWithHeaderForTests(
    envelopeKeyFromBytes(versionKey),
    header,
    payload
  );
  return { versionKey, envelope };
}

function decodeDocument(
  sealedEnvelope: { versionKey: Uint8Array; envelope: Uint8Array },
  kind: ProjectEnvelopeHeader['kind'] = 'document'
) {
  return runDecodeJob({
    type: 'project-envelope',
    kind,
    ...sealedEnvelope
  }) as Promise<ProjectEnvelopeDecodeResult>;
}

describe('decode ceilings', () => {
  it('holds documents to the cloud document limit and blobs to their kind', () => {
    expect(decodeCeiling('document')).toBe(MAX_CLOUD_PROJECT_DOCUMENT_BYTES);
    expect(decodeCeiling('share-snapshot')).toBe(
      MAX_CLOUD_PROJECT_DOCUMENT_BYTES
    );
    expect(decodeCeiling('import-source')).toBe(128 * MIB);
    expect(decodeCeiling('mesh-payload')).toBe(128 * MIB);
    for (const kind of ['thumbnail', 'measurements', 'view-state'] as const) {
      expect(decodeCeiling(kind)).toBe(PLAINTEXT_CEILINGS[kind]);
      expect(decodeCeiling(kind)).toBeLessThan(128 * MIB);
    }
  });
});

describe('project envelope jobs', () => {
  it('round-trips a valid document', async () => {
    const document = {
      projectId: 'project-decode',
      name: 'Bracket',
      nodes: { a: { kind: 'sketch', depth: [1, 2, 3] } }
    };
    const revisionVersionHashes = new Map([['rev_1', patternBytes(32, 7)]]);
    const result = await decodeDocument(
      await sealed(
        encodeEncryptedDocumentBody(
          { document, blobs: [], revisionVersionHashes },
          HEADER
        )
      )
    );
    expect(result.type).toBe('project-envelope');
    expect(result.value).toEqual({
      document,
      blobs: [],
      revisionVersionHashes
    });
    expect(result.header).toMatchObject({
      kind: 'document',
      projectId: 'project-decode',
      documentVersion: 3
    });
  });

  it('reads each kind with its own body codec', async () => {
    const info = { name: 'Bracket', exports: [] };
    const infoHeader = { kind: 'project-info', keyEpoch: 1 } as const;
    await expect(
      decodeDocument(
        await sealed(encodeProjectInfoBody(info, infoHeader), infoHeader),
        'project-info'
      )
    ).resolves.toMatchObject({ value: info });
    const archive = {
      previousKeys: [{ keyEpoch: 0, key: patternBytes(32, 1) }],
      dedupeSecret: patternBytes(32, 2),
      epochRecord: patternBytes(40, 3),
      epochAuthenticator: patternBytes(32, 4)
    };
    const archiveHeader = { kind: 'key-archive', keyEpoch: 1 } as const;
    await expect(
      decodeDocument(
        await sealed(
          encodeKeyArchiveBody(archive, archiveHeader),
          archiveHeader
        ),
        'key-archive'
      )
    ).resolves.toMatchObject({ value: archive });
    // A document body is not a project info, and the reverse.
    await rejectsWith(
      decodeDocument(
        await sealed(encodeProjectInfoBody(info, infoHeader), infoHeader),
        'document'
      ),
      'context-mismatch'
    );
  });

  it('refuses {} and bodies that are not in their canonical form', async () => {
    for (const kind of ['document', 'project-info', 'key-archive'] as const) {
      await rejectsWith(
        decodeDocument(await sealed(encode('{}'), { kind }), kind),
        'malformed'
      );
    }
    // A plain document, as plaintext projects store it, is not a body.
    await rejectsWith(
      decodeDocument(
        await sealed(encode(JSON.stringify({ projectId: 'project-decode' })))
      ),
      'malformed'
    );
    // The same project info, re-serialized with other spacing.
    const infoHeader = { kind: 'project-info', keyEpoch: 1 } as const;
    const canonical = new TextDecoder().decode(
      encodeProjectInfoBody({ name: 'Bracket', exports: [] }, infoHeader)
    );
    await rejectsWith(
      decodeDocument(
        await sealed(
          encode(JSON.stringify(JSON.parse(canonical), null, 1)),
          infoHeader
        ),
        'project-info'
      ),
      'malformed'
    );
    // An unknown field in a document body.
    const body = JSON.parse(
      new TextDecoder().decode(
        encodeEncryptedDocumentBody(
          {
            document: { projectId: 'project-decode' },
            blobs: [],
            revisionVersionHashes: new Map()
          },
          HEADER
        )
      )
    ) as Record<string, unknown>;
    await rejectsWith(
      decodeDocument(
        await sealed(encode(JSON.stringify({ ...body, extra: true })))
      ),
      'malformed'
    );
  });

  it('refuses kinds that have no body codec yet', async () => {
    for (const kind of ['measurements', 'view-state'] as const) {
      await rejectsWith(
        decodeDocument(await sealed(encode('{}'), { kind }), kind),
        'invalid-argument'
      );
    }
  });

  it('refuses an envelope of another kind', async () => {
    await rejectsWith(
      decodeDocument(await sealed(encode('{}'), { kind: 'measurements' })),
      'context-mismatch'
    );
  });

  it('enforces the expected header fields', async () => {
    await rejectsWith(
      runDecodeJob({
        type: 'project-envelope',
        kind: 'document',
        ...(await sealed(encode('{}'))),
        expect: { documentVersion: 4 }
      }),
      'context-mismatch'
    );
  });

  it('stops a gzip bomb with a small declared size at that size', async () => {
    // 64 MiB of zeros gzips to about 64 KiB, well inside what a 1 MiB
    // declaration may carry, so inflation itself has to stop it.
    const bomb = await gzipBytes(new Uint8Array(64 * MIB));
    expect(bomb.byteLength).toBeLessThan(MIB);
    await rejectsWith(
      decodeDocument(
        await forged(bomb, { compression: 'gzip', plaintextLength: MIB })
      ),
      'limit-exceeded'
    );
  });

  it('refuses a body that inflates to less than its declared size', async () => {
    const body = encode(JSON.stringify({ nodes: {} }));
    await rejectsWith(
      decodeDocument(
        await forged(await gzipBytes(body), {
          compression: 'gzip',
          plaintextLength: body.byteLength + 1
        })
      ),
      'malformed'
    );
  });

  it('refuses a body that inflates to more than its declared size', async () => {
    const body = encode(JSON.stringify({ nodes: {} }));
    await rejectsWith(
      decodeDocument(
        await forged(await gzipBytes(body), {
          compression: 'gzip',
          plaintextLength: body.byteLength - 1
        })
      ),
      'limit-exceeded'
    );
  });

  it('refuses a declared size over the kind ceiling before inflating', async () => {
    const tiny = await gzipBytes(encode('{}'));
    await rejectsWith(
      decodeDocument(
        await forged(tiny, {
          compression: 'gzip',
          plaintextLength: MAX_CLOUD_PROJECT_DOCUMENT_BYTES + 1
        })
      ),
      'limit-exceeded'
    );
    await rejectsWith(
      decodeDocument(
        await forged(tiny, {
          kind: 'measurements',
          compression: 'gzip',
          plaintextLength: PLAINTEXT_CEILINGS.measurements + 1
        }),
        'measurements'
      ),
      'limit-exceeded'
    );
  });

  it('refuses JSON nested too deeply before parsing it', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const deep = `${'['.repeat(80)}${']'.repeat(80)}`;
    await rejectsWith(
      decodeDocument(await sealed(encode(deep))),
      'limit-exceeded'
    );
    expect(parsedText(parse, deep)).toBe(false);
  });

  it('refuses JSON with too many values before parsing it', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const wide = `[${'0,'.repeat(1_200_000)}0]`;
    await rejectsWith(
      decodeDocument(await sealed(encode(wide))),
      'limit-exceeded'
    );
    expect(parsedText(parse, wide)).toBe(false);
  });

  it('runs the structural check on what parses', () => {
    // Under the lexical separator budget, over the document value limit.
    const parse = vi.spyOn(JSON, 'parse');
    const values = `[${'0,'.repeat(599_999)}0]`;
    expect(() => parseGuardedJson(encode(values))).toThrow(
      expect.objectContaining({ code: 'limit-exceeded' })
    );
    expect(parsedText(parse, values)).toBe(true);
  });

  it('refuses a body that is not UTF-8 JSON', () => {
    expect(() => parseGuardedJson(Uint8Array.of(0x7b, 0xff, 0x7d))).toThrow(
      expect.objectContaining({ code: 'malformed' })
    );
    expect(() => parseGuardedJson(encode('{"a":'))).toThrow(
      expect.objectContaining({ code: 'malformed' })
    );
  });

  it('decodes text split across slice boundaries', () => {
    // Multi-byte characters land on every 64 KiB slice edge.
    const text = JSON.stringify({ name: 'é€😀'.repeat(40_000) });
    expect(parseGuardedJson(encode(text))).toEqual(JSON.parse(text));
  });
});

describe('content blob jobs', () => {
  const PLAINTEXT = patternBytes(3 * MIB + 12_345, 7);

  async function blob(
    plaintext: Uint8Array = PLAINTEXT,
    kind: ContentBlobReference['kind'] = 'import-source'
  ) {
    return encryptContentBlob(EnvelopeKey.generate(), kind, plaintext, {
      chunkSize: 64 * 1024
    });
  }

  function joined(chunks: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }

  it('round-trips a multi-chunk blob as transferable pieces', async () => {
    const { envelope, reference } = await blob();
    expect(parseEnvelope(envelope).header.chunkSize).toBe(64 * 1024);
    const result = (await runDecodeJob({
      type: 'content-blob',
      reference,
      envelope,
      output: 'chunks'
    })) as Extract<ContentBlobDecodeResult, { chunks: Uint8Array[] }>;
    expect(result.byteLength).toBe(PLAINTEXT.byteLength);
    expect(result.chunks).toHaveLength(4);
    for (const chunk of result.chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(DECODED_CHUNK_BYTES);
      // Each piece owns its buffer, so it transfers without a neighbour.
      expect(chunk.buffer.byteLength).toBe(chunk.byteLength);
    }
    expect(sameBytes(joined(result.chunks), PLAINTEXT)).toBe(true);
  });

  it('round-trips a blob streamed from a Blob into a Blob', async () => {
    const { envelope, reference } = await blob();
    const result = (await runDecodeJob({
      type: 'content-blob',
      reference,
      envelope: new Blob([envelope]),
      output: 'blob'
    })) as Extract<ContentBlobDecodeResult, { blob: Blob }>;
    expect(result.blob.size).toBe(PLAINTEXT.byteLength);
    expect(
      sameBytes(new Uint8Array(await result.blob.arrayBuffer()), PLAINTEXT)
    ).toBe(true);
  });

  it('refuses a blob whose final chunk is cut short', async () => {
    const { envelope, reference } = await blob();
    for (const cut of [1, 16, 64 * 1024]) {
      await rejectsWith(
        runDecodeJob({
          type: 'content-blob',
          reference,
          envelope: envelope.subarray(0, envelope.byteLength - cut),
          output: 'chunks'
        }),
        'authentication-failed',
        'malformed'
      );
    }
  });

  it('stops a gzip bomb at the declared size', async () => {
    const declared = MIB;
    const bomb = await gzipBytes(new Uint8Array(32 * MIB));
    const writer = await createContentBlobWriterWith(
      envelopeKeyFromBytes(patternBytes(32, 0x21)),
      'mesh-payload',
      { compression: 'gzip', chunkSize: 64 * 1024, plaintextLength: declared },
      queuedRandom(patternBytes(16, 0x31))
    );
    const parts = [writer.prefix];
    for (let at = 0; at < bomb.byteLength; at += 64 * 1024) {
      parts.push(...(await writer.write(bomb.subarray(at, at + 64 * 1024))));
    }
    parts.push(await writer.finish());
    await rejectsWith(
      runDecodeJob({
        type: 'content-blob',
        reference: contentBlobReference(writer),
        envelope: new Blob(parts),
        output: 'chunks'
      }),
      'limit-exceeded'
    );
  });

  it('refuses a declared size over the blob kind ceiling', async () => {
    const { envelope, reference } = await blob(patternBytes(1024), 'thumbnail');
    await rejectsWith(
      runDecodeJob({
        type: 'content-blob',
        reference: {
          ...reference,
          plaintextLength: PLAINTEXT_CEILINGS.thumbnail + 1
        },
        envelope,
        output: 'chunks'
      }),
      'limit-exceeded'
    );
  });

  it('refuses a body that decompresses to other than its declared size', async () => {
    const { envelope, reference } = await blob(patternBytes(2048));
    await rejectsWith(
      runDecodeJob({
        type: 'content-blob',
        reference: { ...reference, plaintextLength: 2047 },
        envelope,
        output: 'chunks'
      }),
      'context-mismatch'
    );
  });
});

describe('worker requests', () => {
  it('answers a refusal with its code and transfers result pieces', async () => {
    const refused = await handleDecodeRequest({
      id: 9,
      job: {
        type: 'project-envelope',
        kind: 'document',
        ...(await sealed(encode('[[[[')))
      }
    });
    expect(refused.response).toMatchObject({
      id: 9,
      ok: false,
      error: { code: 'malformed' }
    });

    const { envelope, reference } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'thumbnail',
      patternBytes(4096)
    );
    const decoded = await handleDecodeRequest({
      id: 10,
      job: { type: 'content-blob', reference, envelope, output: 'chunks' }
    });
    expect(decoded.response).toMatchObject({ id: 10, ok: true });
    expect(decoded.transfer).toHaveLength(1);
    expect(decoded.transfer[0]!.byteLength).toBe(4096);
  });

  it('answers an unknown job as invalid', async () => {
    const reply = await handleDecodeRequest({
      id: 1,
      job: { type: 'nonsense' } as never
    });
    expect(reply.response).toMatchObject({
      ok: false,
      error: { code: 'invalid-argument' }
    });
  });
});
