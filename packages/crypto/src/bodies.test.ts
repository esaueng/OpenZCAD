import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toBase64Url, toHex } from './bytes';
import {
  MAX_EXPORT_CONTENT_TYPE_LENGTH,
  MAX_EXPORT_FILE_NAME_LENGTH,
  MAX_EXPORT_METADATA_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  decodeEncryptedDocumentBody,
  decodeKeyArchiveBody,
  decodeMeasurementsBody,
  decodeProjectInfoBody,
  decodeViewStateBody,
  encodeEncryptedDocumentBody,
  encodeKeyArchiveBody,
  encodeMeasurementsBody,
  encodeProjectInfoBody,
  encodeViewStateBody,
  type BodyEnvelopeHeader,
  type EncryptedDocumentBody,
  type KeyArchiveBody,
  type ProjectInfoBody
} from './bodies';
import {
  EnvelopeKey,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptProjectEnvelope,
  type ContentBlobReference
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import { PLAINTEXT_CEILINGS, type ContentBlobKind } from './header';
import { patternBytes } from './test-support';
import { exportPublicKey, generateSigningKeyPair } from './keys';
import { publicKeyHash } from './codes';
import {
  signShareLinkGrant,
  signShareLinkTombstone,
  type ShareLinkSet
} from './share-links';
import { signMlsAuthorityManifest } from './mls-authority';

function throwsWith(run: () => unknown, code: E2eeErrorCode): void {
  expect(run).toThrow(
    expect.objectContaining({ name: 'E2eeError', code }) as unknown
  );
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytesOf = (value: string) => new TextEncoder().encode(value);

async function reference(
  kind: ContentBlobKind,
  size = 20
): Promise<ContentBlobReference> {
  return (
    await encryptContentBlob(EnvelopeKey.generate(), kind, patternBytes(size))
  ).reference;
}

const header = (
  kind: BodyEnvelopeHeader['kind'],
  blobIds: readonly string[] = [],
  keyEpoch = 3
): BodyEnvelopeHeader => ({ kind, blobIds, keyEpoch });

describe('document bodies', () => {
  async function body(): Promise<EncryptedDocumentBody> {
    return {
      document: { projectId: 'p', version: 4, nodes: {}, revisions: [] },
      blobs: [
        await reference('import-source'),
        await reference('mesh-payload')
      ],
      revisionVersionHashes: new Map([
        ['rev_b', patternBytes(32, 0x20)],
        ['rev_a', patternBytes(32, 0x40)]
      ])
    };
  }

  it('round-trips through a document envelope', async () => {
    const value = await body();
    const blobIds = value.blobs.map((b) => b.blobId);
    const encoded = encodeEncryptedDocumentBody(
      value,
      header('document', blobIds)
    );
    const json = JSON.parse(text(encoded)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'version',
      'document',
      'blobs',
      'revisionVersionHashes'
    ]);
    expect(json.revisionVersionHashes).toEqual({
      rev_a: toHex(patternBytes(32, 0x40)),
      rev_b: toHex(patternBytes(32, 0x20))
    });
    const key = EnvelopeKey.generate();
    const keyBytes = key.bytes;
    const envelope = await encryptProjectEnvelope(
      key,
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 4,
        previousVersionHash: null,
        epochBindingHash: patternBytes(32),
        schemaVersion: 1,
        keyEpoch: 3,
        blobIds
      },
      encoded
    );
    const opened = await decryptProjectEnvelope(keyBytes, envelope);
    const decoded = decodeEncryptedDocumentBody(
      opened.plaintext,
      opened.header
    );
    expect(decoded.document).toEqual(value.document);
    expect(decoded.blobs).toEqual(value.blobs);
    expect(decoded.revisionVersionHashes.get('rev_a')).toEqual(
      patternBytes(32, 0x40)
    );
    // A share snapshot carries the same body.
    expect(() =>
      encodeEncryptedDocumentBody(value, header('share-snapshot', blobIds))
    ).not.toThrow();
  });

  it('refuses a body and header that list different blobs, both ways', async () => {
    const value = await body();
    const [a, b] = value.blobs.map((blob) => blob.blobId);
    for (const blobIds of [[a!], [a!, b!, 'extra'], [a!, a!, b!]]) {
      throwsWith(
        () => encodeEncryptedDocumentBody(value, header('document', blobIds)),
        'context-mismatch'
      );
    }
    const encoded = encodeEncryptedDocumentBody(
      value,
      header('document', [a!, b!])
    );
    // The body lists a blob the header omits, and the reverse.
    throwsWith(
      () => decodeEncryptedDocumentBody(encoded, header('document', [a!])),
      'context-mismatch'
    );
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          encoded,
          header('document', [a!, b!, 'extra'])
        ),
      'context-mismatch'
    );
  });

  it('refuses the wrong envelope kind', async () => {
    const value = await body();
    const blobIds = value.blobs.map((b) => b.blobId);
    throwsWith(
      () => encodeEncryptedDocumentBody(value, header('project-info', blobIds)),
      'invalid-argument'
    );
    const encoded = encodeEncryptedDocumentBody(
      value,
      header('document', blobIds)
    );
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(encoded, header('key-archive', blobIds)),
      'context-mismatch'
    );
  });

  it('refuses malformed and unknown fields strictly', () => {
    const base = {
      version: 1,
      document: {},
      blobs: [],
      revisionVersionHashes: {}
    };
    const bad: unknown[] = [
      { ...base, extra: 1 },
      { ...base, document: [] },
      { ...base, document: null },
      { ...base, blobs: {} },
      { ...base, blobs: [{ blobId: 'x' }] },
      { ...base, revisionVersionHashes: { r: 'AB'.repeat(32) } },
      { ...base, revisionVersionHashes: { r: 'ab' } },
      { ...base, revisionVersionHashes: { 'with space': 'ab'.repeat(32) } },
      { ...base, version: '1' },
      [],
      'text'
    ];
    for (const value of bad) {
      throwsWith(
        () =>
          decodeEncryptedDocumentBody(
            bytesOf(JSON.stringify(value)),
            header('document')
          ),
        'malformed'
      );
    }
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          bytesOf(JSON.stringify({ ...base, version: 3 })),
          header('document')
        ),
      'unsupported-version'
    );
    // Version 2 exists now, and needs its link set; version 1 has none.
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          bytesOf(JSON.stringify({ ...base, version: 2 })),
          header('document')
        ),
      'malformed'
    );
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          bytesOf(
            JSON.stringify({
              ...base,
              shareLinks: { grants: [], tombstones: [] }
            })
          ),
          header('document')
        ),
      'malformed'
    );
    for (const raw of [
      Uint8Array.of(0xff, 0xfe),
      bytesOf('{"version":1'),
      bytesOf('﻿{}')
    ]) {
      throwsWith(
        () => decodeEncryptedDocumentBody(raw, header('document')),
        'malformed'
      );
    }
  });

  it('refuses oversized and over-nested bodies before parsing', () => {
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          new Uint8Array(PLAINTEXT_CEILINGS.document + 1),
          header('document')
        ),
      'limit-exceeded'
    );
    const deep = `{"version":1,"document":${'['.repeat(100)}${']'.repeat(100)}}`;
    throwsWith(
      () => decodeEncryptedDocumentBody(bytesOf(deep), header('document')),
      'limit-exceeded'
    );
    let nested: unknown = {};
    for (let i = 0; i < 100; i += 1) nested = { a: nested };
    throwsWith(
      () =>
        encodeEncryptedDocumentBody(
          {
            document: nested as Record<string, unknown>,
            blobs: [],
            revisionVersionHashes: new Map()
          },
          header('document')
        ),
      'limit-exceeded'
    );
  });

  it('validates what it encodes', async () => {
    const value = await body();
    const blobIds = value.blobs.map((b) => b.blobId);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad: unknown[] = [
      { ...value, document: cyclic },
      { ...value, document: [] },
      { ...value, revisionVersionHashes: { rev: patternBytes(32) } },
      {
        ...value,
        revisionVersionHashes: new Map([['rev', patternBytes(31)]])
      },
      { ...value, revisionVersionHashes: new Map([['', patternBytes(32)]]) },
      { ...value, blobs: [{ ...value.blobs[0], key: patternBytes(3) }] }
    ];
    for (const candidate of bad) {
      throwsWith(
        () =>
          encodeEncryptedDocumentBody(
            candidate as EncryptedDocumentBody,
            header('document', blobIds)
          ),
        'invalid-argument'
      );
    }
  });
});

describe('document bodies v2 (share links)', () => {
  async function linkSet(grantEpoch = 2): Promise<ShareLinkSet> {
    const owner = await generateSigningKeyPair(false);
    const signerKeyHash = await publicKeyHash(
      await exportPublicKey(owner.publicKey)
    );
    const grant = (shareId: string) =>
      signShareLinkGrant(owner.privateKey, {
        projectId: 'p',
        shareId,
        shareKeyHash: patternBytes(32, 0x10),
        mode: 'view',
        keyEpoch: grantEpoch,
        issuedAt: 1,
        signerKeyHash
      });
    return {
      grants: [await grant('share_b'), await grant('share_a')],
      tombstones: [
        await signShareLinkTombstone(owner.privateKey, {
          projectId: 'p',
          shareId: 'share_0',
          keyEpoch: 1,
          issuedAt: 1,
          signerKeyHash
        })
      ]
    };
  }

  const value = (shareLinks?: ShareLinkSet): EncryptedDocumentBody => ({
    document: { name: 'n' },
    blobs: [],
    revisionVersionHashes: new Map(),
    ...(shareLinks ? { shareLinks } : {})
  });

  it('writes version 2 only with a link set, sorted by link id', async () => {
    const set = await linkSet();
    const encoded = encodeEncryptedDocumentBody(value(set), header('document'));
    const json = JSON.parse(text(encoded)) as Record<string, unknown>;
    expect(json.version).toBe(2);
    expect(Object.keys(json)).toEqual([
      'version',
      'document',
      'blobs',
      'revisionVersionHashes',
      'shareLinks'
    ]);
    const decoded = decodeEncryptedDocumentBody(encoded, header('document'));
    // Sorted: share_a first, though it was given second.
    expect(decoded.shareLinks!.grants[0]).toEqual(set.grants[1]);
    expect(decoded.shareLinks!.tombstones).toEqual(set.tombstones);
    // An empty set is still version 2: its tombstones were all dropped.
    const empty = encodeEncryptedDocumentBody(
      value({ grants: [], tombstones: [] }),
      header('document')
    );
    expect(JSON.parse(text(empty))).toMatchObject({
      version: 2,
      shareLinks: { grants: [], tombstones: [] }
    });
    // Without one the body is version 1, exactly as before.
    const v1 = encodeEncryptedDocumentBody(value(), header('document'));
    expect(text(v1)).toBe(
      '{"version":1,"document":{"name":"n"},"blobs":[],"revisionVersionHashes":{}}'
    );
    expect(
      'shareLinks' in decodeEncryptedDocumentBody(v1, header('document'))
    ).toBe(false);
  });

  it('never puts a link set in a share snapshot', async () => {
    const set = await linkSet();
    throwsWith(
      () => encodeEncryptedDocumentBody(value(set), header('share-snapshot')),
      'invalid-argument'
    );
    const encoded = encodeEncryptedDocumentBody(value(set), header('document'));
    throwsWith(
      () => decodeEncryptedDocumentBody(encoded, header('share-snapshot')),
      'context-mismatch'
    );
  });

  it('refuses a grant from a later key epoch than its version', async () => {
    const set = await linkSet(4);
    throwsWith(
      () => encodeEncryptedDocumentBody(value(set), header('document')),
      'context-mismatch'
    );
    const encoded = encodeEncryptedDocumentBody(
      value(set),
      header('document', [], 4)
    );
    throwsWith(
      () => decodeEncryptedDocumentBody(encoded, header('document', [], 3)),
      'context-mismatch'
    );
  });

  it('refuses a non-canonical or inconsistent link set', async () => {
    const set = await linkSet();
    const encoded = encodeEncryptedDocumentBody(value(set), header('document'));
    const json = JSON.parse(text(encoded)) as {
      shareLinks: {
        grants: { grant: string; signature: string }[];
        tombstones: { tombstone: string; signature: string }[];
      };
    };
    const variants: unknown[] = [
      // Unsorted grants.
      {
        ...json,
        shareLinks: {
          ...json.shareLinks,
          grants: [...json.shareLinks.grants].reverse()
        }
      },
      // A duplicated grant.
      {
        ...json,
        shareLinks: {
          ...json.shareLinks,
          grants: [json.shareLinks.grants[0], json.shareLinks.grants[0]]
        }
      },
      // Padded base64url.
      {
        ...json,
        shareLinks: {
          ...json.shareLinks,
          grants: [
            {
              ...json.shareLinks.grants[0]!,
              signature: `${json.shareLinks.grants[0]!.signature}=`
            }
          ]
        }
      },
      // A tombstone in the grants list.
      {
        ...json,
        shareLinks: {
          ...json.shareLinks,
          grants: [
            {
              grant: json.shareLinks.tombstones[0]!.tombstone,
              signature: json.shareLinks.tombstones[0]!.signature
            }
          ]
        }
      },
      // Unknown fields.
      { ...json, shareLinks: { ...json.shareLinks, extra: [] } },
      {
        ...json,
        shareLinks: {
          ...json.shareLinks,
          tombstones: [{ ...json.shareLinks.tombstones[0], extra: 1 }]
        }
      },
      { ...json, shareLinks: [] }
    ];
    for (const variant of variants) {
      throwsWith(
        () =>
          decodeEncryptedDocumentBody(
            bytesOf(JSON.stringify(variant)),
            header('document')
          ),
        'malformed'
      );
    }
    // A link that is also tombstoned, on either side.
    const owner = await generateSigningKeyPair(false);
    const signerKeyHash = await publicKeyHash(
      await exportPublicKey(owner.publicKey)
    );
    const both: ShareLinkSet = {
      grants: [
        await signShareLinkGrant(owner.privateKey, {
          projectId: 'p',
          shareId: 'share_a',
          shareKeyHash: patternBytes(32),
          mode: 'tweak',
          keyEpoch: 1,
          issuedAt: 1,
          signerKeyHash
        })
      ],
      tombstones: [
        await signShareLinkTombstone(owner.privateKey, {
          projectId: 'p',
          shareId: 'share_a',
          keyEpoch: 2,
          issuedAt: 2,
          signerKeyHash
        })
      ]
    };
    throwsWith(
      () => encodeEncryptedDocumentBody(value(both), header('document')),
      'context-mismatch'
    );
    const spliced = encodeEncryptedDocumentBody(
      value({ grants: both.grants, tombstones: [] }),
      header('document')
    );
    const tombstoned = JSON.parse(text(spliced)) as typeof json;
    tombstoned.shareLinks.tombstones = [
      {
        tombstone: toBase64Url(both.tombstones[0]!.statement),
        signature: toBase64Url(both.tombstones[0]!.signature)
      }
    ];
    throwsWith(
      () =>
        decodeEncryptedDocumentBody(
          bytesOf(JSON.stringify(tombstoned)),
          header('document')
        ),
      'context-mismatch'
    );
    const sameId = await linkSet();
    throwsWith(
      () =>
        encodeEncryptedDocumentBody(
          value({
            grants: sameId.grants,
            tombstones: [...sameId.tombstones, ...sameId.tombstones]
          }),
          header('document')
        ),
      'invalid-argument'
    );
  });
});

describe('project info limits', () => {
  it('match the app limits they mirror', async () => {
    const shared = await import('@openzcad/shared');
    expect(MAX_PROJECT_NAME_LENGTH).toBe(shared.MAX_PROJECT_NAME_LENGTH);
    const source = readFileSync(
      new URL('../../../apps/web/worker/validation.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain(
      `MAX_FILE_NAME_LENGTH = ${MAX_EXPORT_FILE_NAME_LENGTH};`
    );
    expect(source).toContain(
      `MAX_CONTENT_TYPE_LENGTH = ${MAX_EXPORT_CONTENT_TYPE_LENGTH};`
    );
    expect(source).toContain(
      `JSON.stringify(metadata).length > ${MAX_EXPORT_METADATA_LENGTH.toLocaleString('en-US').replace(',', '_')}`
    );
  });
});

describe('project info bodies', () => {
  async function info(): Promise<ProjectInfoBody> {
    return {
      name: 'Bracket v2 — ünïcode',
      thumbnail: await reference('thumbnail'),
      exports: [
        {
          ref: await reference('export'),
          fileName: 'bracket.step',
          contentType: 'model/step',
          metadata: { units: 'mm', bodies: 2, binary: false }
        }
      ]
    };
  }

  const blobIdsOf = (value: ProjectInfoBody) => [
    ...(value.thumbnail ? [value.thumbnail.blobId] : []),
    ...value.exports.map((entry) => entry.ref.blobId)
  ];

  it('round-trips, with or without a thumbnail', async () => {
    const value = await info();
    const encoded = encodeProjectInfoBody(
      value,
      header('project-info', blobIdsOf(value))
    );
    expect(
      decodeProjectInfoBody(encoded, header('project-info', blobIdsOf(value)))
    ).toEqual(value);
    const bare: ProjectInfoBody = { name: 'Plain', exports: [] };
    const plain = encodeProjectInfoBody(bare, header('project-info'));
    expect(text(plain)).toBe('{"version":1,"name":"Plain","exports":[]}');
    expect(decodeProjectInfoBody(plain, header('project-info'))).toEqual(bare);
  });

  it('refuses a header and body that list different blobs, both ways', async () => {
    const value = await info();
    const ids = blobIdsOf(value);
    throwsWith(
      () => encodeProjectInfoBody(value, header('project-info', [ids[0]!])),
      'context-mismatch'
    );
    throwsWith(
      () =>
        encodeProjectInfoBody(value, header('project-info', [...ids, 'more'])),
      'context-mismatch'
    );
    const encoded = encodeProjectInfoBody(value, header('project-info', ids));
    throwsWith(
      () => decodeProjectInfoBody(encoded, header('project-info', [ids[1]!])),
      'context-mismatch'
    );
    throwsWith(
      () =>
        decodeProjectInfoBody(encoded, header('project-info', [...ids, 'z'])),
      'context-mismatch'
    );
  });

  it('refuses wrong blob kinds and bad fields', async () => {
    const value = await info();
    const wrong: ProjectInfoBody[] = [
      { ...value, thumbnail: await reference('mesh-payload') },
      {
        ...value,
        exports: [{ ...value.exports[0]!, ref: await reference('thumbnail') }]
      },
      { ...value, name: '' },
      { ...value, name: 'x'.repeat(201) },
      { ...value, name: '\uD800' },
      { ...value, exports: [{ ...value.exports[0]!, fileName: '' }] },
      { ...value, exports: [{ ...value.exports[0]!, contentType: 'tab\t' }] },
      {
        ...value,
        exports: [
          {
            ...value.exports[0]!,
            metadata: { nested: {} } as unknown as Record<string, string>
          }
        ]
      },
      {
        ...value,
        exports: [{ ...value.exports[0]!, metadata: { big: 'x'.repeat(4000) } }]
      }
    ];
    for (const candidate of wrong) {
      throwsWith(
        () =>
          encodeProjectInfoBody(
            candidate,
            header('project-info', blobIdsOf(candidate))
          ),
        'invalid-argument'
      );
    }
  });

  it('accepts only its canonical encoding', async () => {
    const plain = '{"version":1,"name":"Plain","exports":[]}';
    for (const variant of [
      '{"name":"Plain","version":1,"exports":[]}',
      '{"version":1, "name":"Plain","exports":[]}',
      '{"version":1,"name":"Pl\\u0061in","exports":[]}',
      '{"version":1,"name":"Plain","exports":[],"extra":0}',
      '{"version":1,"name":"Plain"}'
    ]) {
      throwsWith(
        () => decodeProjectInfoBody(bytesOf(variant), header('project-info')),
        'malformed'
      );
    }
    expect(() =>
      decodeProjectInfoBody(bytesOf(plain), header('project-info'))
    ).not.toThrow();
    throwsWith(
      () =>
        decodeProjectInfoBody(
          new Uint8Array(PLAINTEXT_CEILINGS['project-info'] + 1),
          header('project-info')
        ),
      'limit-exceeded'
    );
  });
});

describe('key archive bodies', () => {
  const archive: KeyArchiveBody = {
    previousKeys: [
      { keyEpoch: 0, key: patternBytes(32, 0x00) },
      { keyEpoch: 2, key: patternBytes(32, 0x20) }
    ],
    dedupeSecret: patternBytes(32, 0x40),
    epochRecord: patternBytes(300, 0x60),
    epochAuthenticator: patternBytes(32, 0x80)
  };

  it('carries signed generation roots in version 2 while preserving legacy archives', async () => {
    const signer = await generateSigningKeyPair();
    const authorityManifest = await signMlsAuthorityManifest(
      signer.privateKey,
      {
        projectId: 'project_test',
        ownerUserId: 'owner',
        ownerIdentityKeyHash: '1'.repeat(64),
        roots: [{ generation: 0, keyEpochBase: 0, groupInfo: 'AA' }],
        checkpoint: { generation: 0, keyEpoch: 3, groupInfo: 'AQ' },
        signerDeviceId: 'owner_laptop'
      }
    );
    const encoded = encodeKeyArchiveBody(
      { ...archive, authorityManifest },
      header('key-archive')
    );
    expect(decodeKeyArchiveBody(encoded, header('key-archive'))).toEqual({
      ...archive,
      authorityManifest
    });
    const json = JSON.parse(text(encoded)) as Record<string, unknown>;
    expect(json.version).toBe(2);
    const { authorityManifest: _, ...missing } = json;
    for (const value of [
      missing,
      { ...json, version: 1 },
      { ...json, version: 3 },
      { ...json, authorityManifest: null }
    ])
      expect(() =>
        decodeKeyArchiveBody(
          bytesOf(JSON.stringify(value)),
          header('key-archive')
        )
      ).toThrow();
  });

  it('round-trips with base64url bytes', () => {
    const encoded = encodeKeyArchiveBody(archive, header('key-archive'));
    const json = JSON.parse(text(encoded)) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'version',
      'previousKeys',
      'dedupeSecret',
      'epochRecord',
      'epochAuthenticator'
    ]);
    expect(json.dedupeSecret).toBe(
      'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8'
    );
    expect(decodeKeyArchiveBody(encoded, header('key-archive'))).toEqual(
      archive
    );
  });

  it('carries only keys older than its own epoch, ascending', () => {
    for (const keyEpoch of [2, 1]) {
      throwsWith(
        () =>
          encodeKeyArchiveBody(archive, header('key-archive', [], keyEpoch)),
        'invalid-argument'
      );
    }
    const encoded = encodeKeyArchiveBody(archive, header('key-archive'));
    throwsWith(
      () => decodeKeyArchiveBody(encoded, header('key-archive', [], 2)),
      'context-mismatch'
    );
    throwsWith(
      () =>
        encodeKeyArchiveBody(
          { ...archive, previousKeys: [...archive.previousKeys].reverse() },
          header('key-archive')
        ),
      'invalid-argument'
    );
  });

  it('references no content blobs', () => {
    throwsWith(
      () => encodeKeyArchiveBody(archive, header('key-archive', ['blob'])),
      'context-mismatch'
    );
    const encoded = encodeKeyArchiveBody(archive, header('key-archive'));
    throwsWith(
      () => decodeKeyArchiveBody(encoded, header('key-archive', ['blob'])),
      'context-mismatch'
    );
  });

  it('refuses bad sizes, non-canonical base64url and oversize bodies', () => {
    for (const candidate of [
      { ...archive, dedupeSecret: patternBytes(31) },
      { ...archive, epochAuthenticator: patternBytes(31) },
      { ...archive, epochAuthenticator: patternBytes(65) },
      { ...archive, epochRecord: new Uint8Array() },
      {
        ...archive,
        previousKeys: [{ keyEpoch: 0, key: patternBytes(16) }]
      }
    ]) {
      throwsWith(
        () => encodeKeyArchiveBody(candidate, header('key-archive')),
        'invalid-argument'
      );
    }
    throwsWith(
      () =>
        encodeKeyArchiveBody(
          { ...archive, epochRecord: new Uint8Array(800 * 1024) },
          header('key-archive')
        ),
      'limit-exceeded'
    );
    const json = JSON.parse(
      text(encodeKeyArchiveBody(archive, header('key-archive')))
    ) as Record<string, string>;
    // "QEFC…Xl8" ends in a character whose low bits are unused; "Xl9"
    // decodes to the same bytes but is not the canonical encoding.
    for (const variant of [
      { ...json, dedupeSecret: `${json.dedupeSecret!.slice(0, -1)}9` },
      { ...json, dedupeSecret: `${json.dedupeSecret}=` },
      { ...json, epochAuthenticator: '' },
      { ...json, version: 1.5 }
    ]) {
      throwsWith(
        () =>
          decodeKeyArchiveBody(
            bytesOf(JSON.stringify(variant)),
            header('key-archive')
          ),
        'malformed'
      );
    }
    throwsWith(
      () =>
        decodeKeyArchiveBody(
          new Uint8Array(PLAINTEXT_CEILINGS['key-archive'] + 1),
          header('key-archive')
        ),
      'limit-exceeded'
    );
    expect(() =>
      decodeKeyArchiveBody(bytesOf('{}'), header('key-archive'))
    ).toThrow(E2eeError);
  });
});

describe('measurement and view-state bodies', () => {
  const codecs = [
    {
      kind: 'measurements' as const,
      field: 'record',
      encode: (value: Record<string, unknown>, h: BodyEnvelopeHeader) =>
        encodeMeasurementsBody({ record: value }, h),
      decode: (bytes: Uint8Array, h: BodyEnvelopeHeader) =>
        decodeMeasurementsBody(bytes, h).record
    },
    {
      kind: 'view-state' as const,
      field: 'session',
      encode: (value: Record<string, unknown>, h: BodyEnvelopeHeader) =>
        encodeViewStateBody({ session: value }, h),
      decode: (bytes: Uint8Array, h: BodyEnvelopeHeader) =>
        decodeViewStateBody(bytes, h).session
    }
  ];

  it('round-trips the app record through its envelope', async () => {
    for (const codec of codecs) {
      const value = { projectId: 'p', items: [{ a: 1 }], nested: { b: true } };
      const init = {
        kind: codec.kind,
        projectId: 'p',
        documentVersion: 3,
        previousVersionHash: null,
        epochBindingHash: new Uint8Array(32),
        schemaVersion: 1,
        keyEpoch: 2
      };
      const key = EnvelopeKey.generate();
      const raw = key.bytes;
      const envelope = await encryptProjectEnvelope(
        key,
        init,
        codec.encode(value, header(codec.kind, [], 2))
      );
      const opened = await decryptProjectEnvelope(raw, envelope, {
        expect: { kind: codec.kind, projectId: 'p', documentVersion: 3 }
      });
      expect(codec.decode(opened.plaintext, opened.header)).toEqual(value);
      expect(JSON.parse(text(codec.encode(value, header(codec.kind))))).toEqual(
        { version: 1, [codec.field]: value }
      );
    }
  });

  it('refuses other kinds, blob references and stray fields', async () => {
    const blob = await reference('thumbnail');
    for (const codec of codecs) {
      const other =
        codec.kind === 'measurements' ? 'view-state' : 'measurements';
      throwsWith(() => codec.encode({}, header(other)), 'invalid-argument');
      throwsWith(
        () => codec.decode(bytesOf('{"version":1}'), header(other)),
        'context-mismatch'
      );
      // Neither kind carries content blobs.
      throwsWith(
        () => codec.encode({}, header(codec.kind, [blob.blobId])),
        'context-mismatch'
      );
      const good = codec.encode({ a: 1 }, header(codec.kind));
      throwsWith(
        () => codec.decode(good, header(codec.kind, [blob.blobId])),
        'context-mismatch'
      );
      for (const variant of [
        {},
        { version: 1 },
        { version: 1, [codec.field]: [] },
        { version: 1, [codec.field]: 'x' },
        { version: 1, [codec.field]: {}, extra: 1 }
      ]) {
        throwsWith(
          () =>
            codec.decode(bytesOf(JSON.stringify(variant)), header(codec.kind)),
          'malformed'
        );
      }
      throwsWith(
        () =>
          codec.decode(
            bytesOf(JSON.stringify({ version: 2, [codec.field]: {} })),
            header(codec.kind)
          ),
        'unsupported-version'
      );
      throwsWith(
        () => codec.encode([] as never, header(codec.kind)),
        'invalid-argument'
      );
    }
  });

  it('refuses oversized and over-nested bodies before parsing', () => {
    for (const codec of codecs) {
      throwsWith(
        () =>
          codec.decode(
            new Uint8Array(PLAINTEXT_CEILINGS[codec.kind] + 1),
            header(codec.kind)
          ),
        'limit-exceeded'
      );
      const deep = `{"version":1,"${codec.field}":${'{"a":'.repeat(40)}1${'}'.repeat(40)}}`;
      throwsWith(
        () => codec.decode(bytesOf(deep), header(codec.kind)),
        'limit-exceeded'
      );
    }
  });
});
