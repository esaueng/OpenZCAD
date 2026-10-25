/**
 * Seeded fuzzing of every parser that reads bytes the server hands back:
 * both envelope classes (structure and decryption, one-shot and
 * incremental), wrapped and sealed keys, version signatures, version log
 * records, device-list entries, revocation cutoffs and the document,
 * project-info and key-archive bodies. Whatever
 * the input, each call either succeeds or throws an `E2eeError`; never a
 * TypeError, RangeError or a DOMException leaking out of WebCrypto.
 */
import { describe, expect, it } from 'vitest';
import { concatBytes, type Bytes } from './bytes';
import {
  EnvelopeKey,
  createContentBlobReader,
  decryptContentBlob,
  decryptProjectEnvelope,
  encryptContentBlob,
  encryptProjectEnvelope,
  parseEnvelope
} from './envelope';
import {
  nextDeviceListEntry,
  signDeviceListEntry,
  signRevocationCutoffs,
  verifyDeviceList,
  verifyRevocationCutoffs
} from './devices';
import { E2eeError } from './errors';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from './keys';
import { signProjectEnvelope, verifyProjectEnvelopeSignature } from './signing';
import { patternBytes, seededRandom } from './test-support';
import {
  decodeEncryptedDocumentBody,
  decodeKeyArchiveBody,
  decodeMeasurementsBody,
  decodeProjectInfoBody,
  decodeViewStateBody,
  encodeEncryptedDocumentBody,
  encodeKeyArchiveBody,
  encodeMeasurementsBody,
  encodeProjectInfoBody,
  encodeViewStateBody
} from './bodies';
import {
  decodeVersionLogRecord,
  encodeVersionLogRecord,
  verifyVersionLog,
  versionLogRecord
} from './version-log';
import {
  openSealedKey,
  sealKey,
  unwrapKey,
  wrapKey,
  type SealContext,
  type WrapContext
} from './wrap';

const WRAP_CONTEXT: WrapContext = {
  purpose: 'version-key',
  projectId: 'p',
  keyEpoch: 0,
  kind: 'document',
  versionId: '1'
};
const SEAL_CONTEXT: SealContext = {
  purpose: 'project-key',
  userId: 'u1',
  projectId: 'p',
  keyEpoch: 0
};

type Mutator = (input: Bytes, next: () => number) => Bytes;

const int = (next: () => number, below: number) => Math.floor(next() * below);

const MUTATORS: Mutator[] = [
  // Flip one bit.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length) out[int(next, out.length)]! ^= 1 << int(next, 8);
    return out;
  },
  // Overwrite a byte with an extreme value.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length) {
      out[int(next, out.length)] = [0x00, 0x01, 0x02, 0x7f, 0x80, 0xff][
        int(next, 6)
      ]!;
    }
    return out;
  },
  // Truncate anywhere.
  (input, next) => input.slice(0, int(next, input.length + 1)),
  // Insert random bytes.
  (input, next) => {
    const at = int(next, input.length + 1);
    const noise = Uint8Array.from({ length: 1 + int(next, 40) }, () =>
      int(next, 256)
    );
    return concatBytes(input.subarray(0, at), noise, input.subarray(at));
  },
  // Delete a range.
  (input, next) => {
    const at = int(next, input.length + 1);
    return concatBytes(
      input.subarray(0, at),
      input.subarray(at + 1 + int(next, 30))
    );
  },
  // Duplicate a range in place.
  (input, next) => {
    const at = int(next, input.length + 1);
    const span = input.subarray(at, at + 1 + int(next, 100));
    return concatBytes(input.subarray(0, at), span, input.subarray(at));
  },
  // Overwrite a 32-bit length-sized field with a large value.
  (input, next) => {
    const out = new Uint8Array(input);
    if (out.length >= 4) {
      const at = int(next, out.length - 3);
      new DataView(out.buffer).setUint32(
        at,
        [0xffffffff, 0x7fffffff, 0x00100001][int(next, 3)]!
      );
    }
    return out;
  },
  // Pure random bytes, sometimes with a valid magic and version.
  (_input, next) => {
    const noise = Uint8Array.from({ length: int(next, 300) }, () =>
      int(next, 256)
    );
    if (noise.length >= 4 && next() < 0.5) noise.set([0x4f, 0x5a, 0x45, 0x01]);
    return noise;
  }
];

async function onlyTypedErrors(task: () => unknown): Promise<string> {
  try {
    await task();
    return 'ok';
  } catch (error) {
    if (error instanceof E2eeError) return error.code;
    throw new Error(`Untyped error escaped: ${String(error)}`, {
      cause: error
    });
  }
}

function mutate(seed: number, input: Bytes): Bytes {
  const next = seededRandom(seed);
  let out = input;
  for (let rounds = 1 + int(next, 3); rounds > 0; rounds -= 1) {
    out = MUTATORS[int(next, MUTATORS.length)]!(out, next);
  }
  return out;
}

describe('parser fuzzing', () => {
  it('envelope parsing and decryption only throw E2eeError', async () => {
    const versionKey = EnvelopeKey.generate();
    const versionKeyBytes = versionKey.bytes;
    const project = await encryptProjectEnvelope(
      versionKey,
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 1,
        previousVersionHash: patternBytes(32),
        epochBindingHash: patternBytes(32, 1),
        schemaVersion: 1,
        keyEpoch: 0,
        blobIds: ['a', 'b'],
        chunkSize: 64
      },
      patternBytes(500)
    );
    const blob = await encryptContentBlob(
      EnvelopeKey.generate(),
      'mesh-payload',
      patternBytes(300),
      { compression: 'none', chunkSize: 64 }
    );
    const outcomes = new Map<string, number>();
    const record = (outcome: string) =>
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    for (let seed = 1; seed <= 1500; seed += 1) {
      const isProject = seed % 2 === 0;
      const input = mutate(seed, isProject ? project : blob.envelope);
      record(await onlyTypedErrors(() => parseEnvelope(input)));
      record(
        await onlyTypedErrors(() =>
          isProject
            ? decryptProjectEnvelope(versionKeyBytes, input, {
                maxPlaintextBytes: 1 << 20
              })
            : decryptContentBlob(blob.reference, input)
        )
      );
      record(
        await onlyTypedErrors(async () => {
          const reader = createContentBlobReader(blob.reference);
          for (let at = 0; at < input.length; at += 37) {
            await reader.push(input.subarray(at, at + 37));
          }
          await reader.finish();
        })
      );
    }
    // The corpus reaches the interesting refusals, not just one of them.
    for (const code of [
      'malformed',
      'authentication-failed',
      'unsupported-version'
    ]) {
      expect(outcomes.get(code) ?? 0).toBeGreaterThan(0);
    }
  });

  it('version log records and bodies only throw E2eeError', async () => {
    const author = await generateSigningKeyPair();
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 2,
        previousVersionHash: patternBytes(32),
        epochBindingHash: patternBytes(32, 1),
        schemaVersion: 1,
        keyEpoch: 1,
        blobIds: ['b1']
      },
      patternBytes(30)
    );
    const record = encodeVersionLogRecord(
      await versionLogRecord(
        envelope,
        await signProjectEnvelope(author.privateKey, envelope)
      )
    );
    const reference = (
      await encryptContentBlob(
        EnvelopeKey.generate(),
        'import-source',
        patternBytes(10)
      )
    ).reference;
    const blobHeader = {
      kind: 'document' as const,
      keyEpoch: 1,
      blobIds: [reference.blobId]
    };
    const documentBody = encodeEncryptedDocumentBody(
      {
        document: { nodes: { a: { x: [1, 2, { y: 'z' }] } } },
        blobs: [reference],
        revisionVersionHashes: new Map([['r1', patternBytes(32)]])
      },
      blobHeader
    );
    const thumbnail = (
      await encryptContentBlob(
        EnvelopeKey.generate(),
        'thumbnail',
        patternBytes(5)
      )
    ).reference;
    const infoHeader = {
      kind: 'project-info' as const,
      keyEpoch: 1,
      blobIds: [thumbnail.blobId]
    };
    const infoBody = encodeProjectInfoBody(
      { name: 'Part', thumbnail, exports: [] },
      infoHeader
    );
    const archiveHeader = {
      kind: 'key-archive' as const,
      keyEpoch: 2,
      blobIds: []
    };
    const archiveBody = encodeKeyArchiveBody(
      {
        previousKeys: [{ keyEpoch: 0, key: patternBytes(32) }],
        dedupeSecret: patternBytes(32, 1),
        epochRecord: patternBytes(40, 2),
        epochAuthenticator: patternBytes(32, 3)
      },
      archiveHeader
    );
    const recordHeader = (kind: 'measurements' | 'view-state') => ({
      kind,
      keyEpoch: 0,
      blobIds: []
    });
    const measurementsBody = encodeMeasurementsBody(
      { record: { projectId: 'p', measurements: [{ id: 'm', value: 1.5 }] } },
      recordHeader('measurements')
    );
    const viewStateBody = encodeViewStateBody(
      {
        session: { projectId: 'p', state: { camera: { position: [1, 2, 3] } } }
      },
      recordHeader('view-state')
    );
    const outcomes = new Map<string, number>();
    const count = (outcome: string) =>
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    for (let seed = 1; seed <= 600; seed += 1) {
      count(
        await onlyTypedErrors(async () => {
          const decoded = decodeVersionLogRecord(mutate(seed, record));
          await verifyVersionLog([decoded], {
            resolveSigningKey: () => author.publicKey
          });
        })
      );
      count(
        await onlyTypedErrors(() =>
          decodeEncryptedDocumentBody(mutate(seed, documentBody), blobHeader)
        )
      );
      count(
        await onlyTypedErrors(() =>
          decodeProjectInfoBody(mutate(seed, infoBody), infoHeader)
        )
      );
      count(
        await onlyTypedErrors(() =>
          decodeKeyArchiveBody(mutate(seed, archiveBody), archiveHeader)
        )
      );
      count(
        await onlyTypedErrors(() =>
          decodeMeasurementsBody(
            mutate(seed, measurementsBody),
            recordHeader('measurements')
          )
        )
      );
      count(
        await onlyTypedErrors(() =>
          decodeViewStateBody(
            mutate(seed, viewStateBody),
            recordHeader('view-state')
          )
        )
      );
    }
    for (const code of ['malformed', 'authentication-failed']) {
      expect(outcomes.get(code) ?? 0).toBeGreaterThan(0);
    }
  });

  it('device list entries and revocation cutoffs only throw E2eeError', async () => {
    const identity = await generateSigningKeyPair(false);
    const identityRaw = await exportPublicKey(identity.publicKey);
    const raw = async (algorithm: 'ECDH' | 'ECDSA') =>
      exportPublicKey(
        (algorithm === 'ECDH'
          ? await generateEncryptionKeyPair()
          : await generateSigningKeyPair()
        ).publicKey
      );
    const listed = async (deviceId: string) => ({
      deviceId,
      label: deviceId,
      signingKey: await raw('ECDSA'),
      unlockKey: await raw('ECDH'),
      addedAt: 1
    });
    const genesis = await signDeviceListEntry(identity.privateKey, {
      userId: 'u1',
      sequence: 0,
      previousEntryHash: null,
      issuedAt: 1,
      previousIdentityKeyHash: null,
      encryptionKey: await raw('ECDH'),
      accountKeyCommitment: patternBytes(32),
      devices: [await listed('d1'), await listed('d2')],
      unlockTargets: [
        {
          kind: 'recovery-key',
          targetId: 'rk',
          publicKey: await raw('ECDH'),
          addedAt: 1
        }
      ],
      revoked: []
    });
    const list = await verifyDeviceList(identityRaw, [genesis]);
    const removal = await signDeviceListEntry(
      identity.privateKey,
      nextDeviceListEntry(list, {
        issuedAt: 2,
        removeDeviceIds: ['d2'],
        replacedBy: 'd1',
        encryptionKey: await raw('ECDH'),
        accountKeyCommitment: patternBytes(32, 1)
      })
    );
    expect(removal.entry[3]).toBe(2);
    const revoked = await verifyDeviceList(identityRaw, [genesis, removal]);
    const cutoffs = await signRevocationCutoffs(identity.privateKey, {
      userId: 'u1',
      generation: 1,
      entrySequence: 1,
      entryHash: revoked.headHash,
      issuedAt: 3,
      cutoffs: [
        { projectId: 'p1', cutoffEpoch: 2 },
        { projectId: 'p2', cutoffEpoch: 5 }
      ]
    });
    const outcomes = new Map<string, number>();
    const count = (outcome: string) =>
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    for (let seed = 1; seed <= 400; seed += 1) {
      count(
        await onlyTypedErrors(() =>
          verifyDeviceList(identityRaw, [
            genesis,
            {
              entry: mutate(seed, new Uint8Array(removal.entry)),
              signature: removal.signature
            }
          ])
        )
      );
      count(
        await onlyTypedErrors(() =>
          verifyRevocationCutoffs(
            {
              statement: mutate(seed, new Uint8Array(cutoffs.statement)),
              signature: cutoffs.signature
            },
            revoked,
            { generation: 1 }
          )
        )
      );
    }
    for (const code of ['malformed', 'authentication-failed']) {
      expect(outcomes.get(code) ?? 0).toBeGreaterThan(0);
    }
  });

  it('key and signature parsing only throw E2eeError', async () => {
    const kek = patternBytes(32, 0x01);
    const recipient = await generateEncryptionKeyPair();
    const author = await generateSigningKeyPair();
    const symmetric = await wrapKey(kek, patternBytes(32), WRAP_CONTEXT);
    const privateKey = await wrapKey(kek, patternBytes(140), {
      purpose: 'encryption-private-key',
      userId: 'u1',
      keyId: 'k1'
    });
    const sealed = await sealKey(
      recipient.publicKey,
      patternBytes(32),
      SEAL_CONTEXT
    );
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        kind: 'document',
        projectId: 'p',
        documentVersion: 1,
        previousVersionHash: null,
        epochBindingHash: patternBytes(32),
        schemaVersion: 1,
        keyEpoch: 0
      },
      patternBytes(10)
    );
    const signature = await signProjectEnvelope(author.privateKey, envelope);
    for (let seed = 1; seed <= 400; seed += 1) {
      await onlyTypedErrors(() =>
        unwrapKey(kek, mutate(seed, symmetric), WRAP_CONTEXT)
      );
      await onlyTypedErrors(() =>
        unwrapKey(kek, mutate(seed, privateKey), {
          purpose: 'encryption-private-key',
          userId: 'u1',
          keyId: 'k1'
        })
      );
      await onlyTypedErrors(() =>
        openSealedKey(recipient, mutate(seed, sealed), SEAL_CONTEXT)
      );
      await onlyTypedErrors(() =>
        verifyProjectEnvelopeSignature(
          author.publicKey,
          envelope,
          mutate(seed, signature)
        )
      );
      await onlyTypedErrors(() =>
        verifyProjectEnvelopeSignature(
          author.publicKey,
          mutate(seed, envelope),
          signature
        )
      );
    }
  });
});
