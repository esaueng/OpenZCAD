import { describe, expect, it, vi } from 'vitest';
import { concatBytes, type Bytes } from './bytes';
import {
  accountKeyCommitment,
  nextDeviceListEntry,
  signDeviceListEntry,
  verifyDeviceList,
  type DeviceListEntry,
  type ListedDevice,
  type SignedDeviceListEntry,
  type VerifiedDeviceList
} from './devices';
import {
  EnvelopeKey,
  encryptContentBlob,
  encryptProjectEnvelope
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import type { ProjectEnvelopeHeaderInit } from './header';
import {
  exportPublicKey,
  generateEncryptionKeyPair,
  generateSigningKeyPair
} from './keys';
import { generateSymmetricKey } from './primitives';
import { signProjectEnvelope } from './signing';
import { patternBytes } from './test-support';
import {
  AuthorshipError,
  VersionLogError,
  authorCutoffKey,
  decodeVersionLogRecord,
  encodeVersionLogRecord,
  verifyAuthoredEnvelope,
  verifyAuthoredLogRecord,
  verifyVersionLog,
  versionLogRecord,
  type AuthorshipFailure,
  type VersionLogFailure,
  type VersionLogRecord,
  type VersionLogSigner
} from './version-log';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

async function logRefuses(
  promise: Promise<unknown>,
  reason: VersionLogFailure,
  index: number | null
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof VersionLogError &&
      error.reason === reason &&
      error.index === index
  );
}

async function authorRefuses(
  promise: Promise<unknown>,
  reason: AuthorshipFailure
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof AuthorshipError &&
      error.reason === reason &&
      error.code === 'authentication-failed'
  );
}

interface Step {
  readonly documentVersion?: number;
  readonly keyEpoch?: number;
  readonly projectId?: string;
  readonly kind?: ProjectEnvelopeHeaderInit['kind'];
  /** Overrides the link to the previous record. */
  readonly previousVersionHash?: Uint8Array | null;
}

interface Signed {
  readonly envelope: Bytes;
  readonly signature: Bytes;
  readonly record: VersionLogRecord;
}

async function signedChain(
  signer: CryptoKeyPair,
  steps: readonly Step[]
): Promise<Signed[]> {
  const out: Signed[] = [];
  for (const [index, step] of steps.entries()) {
    const before = out.at(-1);
    const envelope = await encryptProjectEnvelope(
      EnvelopeKey.generate(),
      {
        kind: step.kind ?? 'document',
        projectId: step.projectId ?? 'project-a',
        documentVersion: step.documentVersion ?? index + 1,
        previousVersionHash:
          step.previousVersionHash !== undefined
            ? step.previousVersionHash
            : (before?.record.versionHash ?? null),
        epochBindingHash: patternBytes(32, index),
        schemaVersion: 1,
        keyEpoch: step.keyEpoch ?? 0
      },
      patternBytes(40, index)
    );
    const signature = await signProjectEnvelope(
      signer.privateKey,
      envelope,
      1_700_000_000_000 + index
    );
    out.push({
      envelope,
      signature,
      record: await versionLogRecord(envelope, signature)
    });
  }
  return out;
}

const records = (chain: readonly Signed[]) => chain.map((s) => s.record);

describe('version log records', () => {
  it('encode compactly and decode back', async () => {
    const signer = await generateSigningKeyPair();
    const [signed] = await signedChain(signer, [{}]);
    const bytes = encodeVersionLogRecord(signed!.record);
    expect([...bytes.subarray(0, 4)]).toEqual([0x4f, 0x5a, 0x56, 1]);
    expect(bytes.byteLength).toBe(
      4 + 4 + signed!.record.prefix.byteLength + 32 + 1 + 73
    );
    expect(decodeVersionLogRecord(bytes)).toEqual(signed!.record);
  });

  it('refuses foreign, future, truncated and padded records', async () => {
    const signer = await generateSigningKeyPair();
    const [signed] = await signedChain(signer, [{}]);
    const bytes = encodeVersionLogRecord(signed!.record);
    const future = new Uint8Array(bytes);
    future[3] = 2;
    expect(() => decodeVersionLogRecord(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' }) as unknown
    );
    const foreign = new Uint8Array(bytes);
    foreign[2] = 0x45;
    for (const bad of [
      foreign,
      bytes.subarray(0, bytes.byteLength - 1),
      concatBytes(bytes, Uint8Array.of(0)),
      new Uint8Array()
    ]) {
      expect(() => decodeVersionLogRecord(bad)).toThrow(
        expect.objectContaining({ code: 'malformed' }) as unknown
      );
    }
  });

  it('are made only for project envelopes', async () => {
    const signer = await generateSigningKeyPair();
    const [signed] = await signedChain(signer, [{}]);
    const blob = await encryptContentBlob(
      EnvelopeKey.generate(),
      'thumbnail',
      patternBytes(10)
    );
    await rejectsWith(
      versionLogRecord(blob.envelope, signed!.signature),
      'invalid-argument'
    );
    await rejectsWith(
      versionLogRecord(signed!.envelope, signed!.signature.subarray(1)),
      'unsupported-version'
    );
  });
});

describe('verifyVersionLog', () => {
  it('verifies a signed log without any envelope body', async () => {
    const signer = await generateSigningKeyPair();
    const chain = await signedChain(signer, [
      {},
      { keyEpoch: 1 },
      { keyEpoch: 1 },
      { documentVersion: 9, keyEpoch: 4 }
    ]);
    const resolve = vi.fn((_signer: VersionLogSigner) => signer.publicKey);
    const log = await verifyVersionLog(records(chain), {
      pinnedVersionHash: chain[1]!.record.versionHash,
      projectId: 'project-a',
      resolveSigningKey: resolve
    });
    expect(log.entries.map((e) => e.header.documentVersion)).toEqual([
      1, 2, 3, 9
    ]);
    expect(log.head.versionHash).toEqual(chain[3]!.record.versionHash);
    expect(log.head.signedAt).toBe(1_700_000_000_003);
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(resolve.mock.calls[2]![0]).toMatchObject({
      index: 2,
      signedAt: 1_700_000_000_002,
      header: { documentVersion: 3, projectId: 'project-a' }
    });
    // Raw public keys work too.
    const raw = await exportPublicKey(signer.publicKey);
    await expect(
      verifyVersionLog(records(chain), { resolveSigningKey: () => raw })
    ).resolves.toMatchObject({ head: { signedAt: 1_700_000_000_003 } });
  });

  it('refuses an empty log', async () => {
    await logRefuses(
      verifyVersionLog([], { resolveSigningKey: () => null }),
      'empty',
      null
    );
  });

  it('refuses a gap: a record missing from the middle', async () => {
    const signer = await generateSigningKeyPair();
    const chain = records(await signedChain(signer, [{}, {}, {}]));
    await logRefuses(
      verifyVersionLog([chain[0]!, chain[2]!], {
        resolveSigningKey: () => signer.publicKey
      }),
      'previous-hash-mismatch',
      1
    );
  });

  it('refuses a version that does not increase', async () => {
    const signer = await generateSigningKeyPair();
    for (const documentVersion of [1, 0]) {
      const chain = await signedChain(signer, [
        { documentVersion: 1 },
        { documentVersion }
      ]);
      await logRefuses(
        verifyVersionLog(records(chain), {
          resolveSigningKey: () => signer.publicKey
        }),
        'version-not-increasing',
        1
      );
    }
  });

  it('refuses a key epoch that decreases', async () => {
    const signer = await generateSigningKeyPair();
    const chain = await signedChain(signer, [{ keyEpoch: 3 }, { keyEpoch: 2 }]);
    await logRefuses(
      verifyVersionLog(records(chain), {
        resolveSigningKey: () => signer.publicKey
      }),
      'epoch-decreased',
      1
    );
  });

  it('refuses a record that names another parent, or none', async () => {
    const signer = await generateSigningKeyPair();
    for (const previousVersionHash of [patternBytes(32, 0x99), null]) {
      const chain = await signedChain(signer, [{}, { previousVersionHash }]);
      await logRefuses(
        verifyVersionLog(records(chain), {
          resolveSigningKey: () => signer.publicKey
        }),
        'previous-hash-mismatch',
        1
      );
    }
  });

  it('refuses another project or another kind', async () => {
    const signer = await generateSigningKeyPair();
    const other = await signedChain(signer, [{}, { projectId: 'project-b' }]);
    await logRefuses(
      verifyVersionLog(records(other), {
        resolveSigningKey: () => signer.publicKey
      }),
      'project-mismatch',
      1
    );
    const same = await signedChain(signer, [{}]);
    await logRefuses(
      verifyVersionLog(records(same), {
        projectId: 'project-b',
        resolveSigningKey: () => signer.publicKey
      }),
      'project-mismatch',
      0
    );
    const kinds = await signedChain(signer, [{}, { kind: 'share-snapshot' }]);
    await logRefuses(
      verifyVersionLog(records(kinds), {
        resolveSigningKey: () => signer.publicKey
      }),
      'kind-mismatch',
      1
    );
  });

  it('refuses a signature by another key, or an unknown signer', async () => {
    const signer = await generateSigningKeyPair();
    const stranger = await generateSigningKeyPair();
    const chain = records(await signedChain(signer, [{}, {}]));
    await logRefuses(
      verifyVersionLog(chain, {
        resolveSigningKey: ({ index }) =>
          index === 1 ? stranger.publicKey : signer.publicKey
      }),
      'signature-invalid',
      1
    );
    await logRefuses(
      verifyVersionLog(chain, {
        resolveSigningKey: async ({ index }) =>
          index === 0 ? null : signer.publicKey
      }),
      'signer-unknown',
      0
    );
    // The error codes stay the package's stable ones.
    await rejectsWith(
      verifyVersionLog(chain, { resolveSigningKey: () => stranger.publicKey }),
      'authentication-failed'
    );
  });

  it('refuses a record whose version hash or prefix was swapped', async () => {
    const signer = await generateSigningKeyPair();
    const [a] = await signedChain(signer, [{}]);
    const [b] = await signedChain(signer, [{ keyEpoch: 7 }]);
    for (const forged of [
      { ...a!.record, versionHash: b!.record.versionHash },
      { ...a!.record, prefix: b!.record.prefix }
    ]) {
      await logRefuses(
        verifyVersionLog([forged], {
          resolveSigningKey: () => signer.publicKey
        }),
        'signature-invalid',
        0
      );
    }
  });

  it('detects rollback and forks through the pin', async () => {
    const signer = await generateSigningKeyPair();
    const chain = await signedChain(signer, [{}, {}, {}]);
    const resolveSigningKey = () => signer.publicKey;
    // Rolled back: the server serves the log only up to version 2.
    await logRefuses(
      verifyVersionLog(records(chain).slice(0, 2), {
        pinnedVersionHash: chain[2]!.record.versionHash,
        resolveSigningKey
      }),
      'pinned-missing',
      null
    );
    // Forked: a second, validly signed branch from version 1.
    const fork = await signedChain(signer, [
      {},
      { previousVersionHash: chain[0]!.record.versionHash, keyEpoch: 2 }
    ]);
    await logRefuses(
      verifyVersionLog([chain[0]!.record, fork[1]!.record], {
        pinnedVersionHash: chain[2]!.record.versionHash,
        resolveSigningKey
      }),
      'pinned-missing',
      null
    );
    await rejectsWith(
      verifyVersionLog(records(chain).slice(0, 2), {
        pinnedVersionHash: chain[2]!.record.versionHash,
        resolveSigningKey
      }),
      'chain-broken'
    );
  });

  it('copies the records before the first await', async () => {
    const signer = await generateSigningKeyPair();
    const chain = records(await signedChain(signer, [{}, {}]));
    const list = chain.map((record) => ({
      prefix: new Uint8Array(record.prefix),
      versionHash: new Uint8Array(record.versionHash),
      signature: new Uint8Array(record.signature)
    }));
    const pending = verifyVersionLog(list, {
      resolveSigningKey: () => signer.publicKey
    });
    list[1]!.versionHash.fill(0);
    list.pop();
    await expect(pending).resolves.toMatchObject({
      head: { header: { documentVersion: 2 } }
    });
  });
});

// --- Authorship -----------------------------------------------------------

async function rawKey(algorithm: 'ECDH' | 'ECDSA'): Promise<Uint8Array> {
  const pair =
    algorithm === 'ECDH'
      ? await generateEncryptionKeyPair()
      : await generateSigningKeyPair();
  return exportPublicKey(pair.publicKey);
}

interface Author {
  readonly signers: CryptoKeyPair[];
  readonly identity: CryptoKeyPair;
  readonly identityRaw: Uint8Array;
  chain: SignedDeviceListEntry[];
}

async function author(userId: string, devices = 2): Promise<Author> {
  const identity = await generateSigningKeyPair(false);
  const signers: CryptoKeyPair[] = [];
  const listed: ListedDevice[] = [];
  for (let i = 0; i < devices; i += 1) {
    const pair = await generateSigningKeyPair();
    signers.push(pair);
    listed.push({
      deviceId: `dev_${i}`,
      label: `Device ${i}`,
      signingKey: await exportPublicKey(pair.publicKey),
      unlockKey: await rawKey('ECDH'),
      addedAt: 1_700_000_000_000
    });
  }
  const genesis: DeviceListEntry = {
    userId,
    sequence: 0,
    previousEntryHash: null,
    issuedAt: 1_700_000_000_000,
    previousIdentityKeyHash: null,
    encryptionKey: await rawKey('ECDH'),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey()),
    devices: listed,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId: 'rk_1',
        publicKey: await rawKey('ECDH'),
        addedAt: 1_700_000_000_000
      }
    ],
    revoked: []
  };
  return {
    signers,
    identity,
    identityRaw: await exportPublicKey(identity.publicKey),
    chain: [await signDeviceListEntry(identity.privateKey, genesis)]
  };
}

async function listOf(a: Author): Promise<VerifiedDeviceList> {
  return verifyDeviceList(a.identityRaw, a.chain);
}

async function revoke(a: Author, deviceId: string): Promise<void> {
  const list = await listOf(a);
  const entry = nextDeviceListEntry(list, {
    issuedAt: 1_700_000_100_000,
    removeDeviceIds: [deviceId],
    encryptionKey: await rawKey('ECDH'),
    accountKeyCommitment: await accountKeyCommitment(generateSymmetricKey())
  });
  a.chain = [
    ...a.chain,
    await signDeviceListEntry(a.identity.privateKey, entry)
  ];
}

describe('verifyAuthoredEnvelope', () => {
  it('names the certified device that signed a version', async () => {
    const alice = await author('alice');
    const bob = await author('bob');
    const [signed] = await signedChain(bob.signers[1]!, [{}]);
    const verified = await verifyAuthoredEnvelope(
      signed!.envelope,
      signed!.signature,
      { deviceLists: [await listOf(alice), await listOf(bob)] }
    );
    expect(verified).toMatchObject({
      userId: 'bob',
      deviceId: 'dev_1',
      revoked: false,
      signedAt: 1_700_000_000_000,
      header: { documentVersion: 1 }
    });
    expect(verified.versionHash).toEqual(signed!.record.versionHash);
    // What the caller needs for the leaf-role check in the version's epoch:
    // the signing device (above) and the epoch the header names.
    expect(Number.isInteger(verified.header.keyEpoch)).toBe(true);
    expect(verified.header.epochBindingHash).toHaveLength(32);
    // The log record alone is enough.
    await expect(
      verifyAuthoredLogRecord(signed!.record, {
        deviceLists: [await listOf(bob)]
      })
    ).resolves.toMatchObject({ userId: 'bob', deviceId: 'dev_1' });
  });

  it('refuses a key no given device list certifies', async () => {
    const alice = await author('alice');
    const stranger = await generateSigningKeyPair();
    const [signed] = await signedChain(stranger, [{}]);
    await authorRefuses(
      verifyAuthoredEnvelope(signed!.envelope, signed!.signature, {
        deviceLists: [await listOf(alice)]
      }),
      'unknown-signer'
    );
    // A body re-encrypted under the same header fails too: the signature
    // covers the version hash of every chunk.
    const [mine] = await signedChain(alice.signers[0]!, [{}]);
    const forged = new Uint8Array(mine!.envelope);
    forged[forged.byteLength - 1]! ^= 1;
    await authorRefuses(
      verifyAuthoredEnvelope(forged, mine!.signature, {
        deviceLists: [await listOf(alice)]
      }),
      'unknown-signer'
    );
  });

  it('accepts a revoked device only at or before its cutoff', async () => {
    const alice = await author('alice');
    const chain = await signedChain(alice.signers[0]!, [{}, {}, {}]);
    await revoke(alice, 'dev_0');
    const lists = [await listOf(alice)];
    const cutoffs = new Map([
      [
        authorCutoffKey('alice', 'dev_0'),
        { documentVersion: 2, versionHash: chain[1]!.record.versionHash }
      ]
    ]);
    // Before and at the cutoff.
    for (const signed of chain.slice(0, 2)) {
      await expect(
        verifyAuthoredEnvelope(signed.envelope, signed.signature, {
          deviceLists: lists,
          cutoffs
        })
      ).resolves.toMatchObject({ deviceId: 'dev_0', revoked: true });
    }
    // After it.
    await authorRefuses(
      verifyAuthoredEnvelope(chain[2]!.envelope, chain[2]!.signature, {
        deviceLists: lists,
        cutoffs
      }),
      'outside-cutoff'
    );
    // A different version claiming the cutoff's number is outside it too.
    const [sibling] = await signedChain(alice.signers[0]!, [
      { documentVersion: 2, keyEpoch: 5 }
    ]);
    await authorRefuses(
      verifyAuthoredEnvelope(sibling!.envelope, sibling!.signature, {
        deviceLists: lists,
        cutoffs
      }),
      'outside-cutoff'
    );
    // No cutoff for this project: refused.
    await authorRefuses(
      verifyAuthoredEnvelope(chain[0]!.envelope, chain[0]!.signature, {
        deviceLists: lists
      }),
      'revoked-without-cutoff'
    );
    // The surviving device is unaffected.
    const [other] = await signedChain(alice.signers[1]!, [{}]);
    await expect(
      verifyAuthoredEnvelope(other!.envelope, other!.signature, {
        deviceLists: lists
      })
    ).resolves.toMatchObject({ deviceId: 'dev_1', revoked: false });
  });

  it('refuses a signing key two users both certify', async () => {
    const alice = await author('alice', 1);
    const mallory = await author('mallory', 1);
    const aliceList = await listOf(alice);
    // Mallory certifies Alice's public signing key as her own device.
    const shared = aliceList.devices[0]!;
    const list = await listOf(mallory);
    const entry = nextDeviceListEntry(list, {
      issuedAt: 1_700_000_200_000,
      addDevices: [
        {
          deviceId: 'copied',
          label: 'Copied',
          signingKey: shared.signingKey,
          unlockKey: await rawKey('ECDH'),
          addedAt: 1_700_000_200_000
        }
      ]
    });
    mallory.chain = [
      ...mallory.chain,
      await signDeviceListEntry(mallory.identity.privateKey, entry)
    ];
    const [signed] = await signedChain(alice.signers[0]!, [{}]);
    await authorRefuses(
      verifyAuthoredEnvelope(signed!.envelope, signed!.signature, {
        deviceLists: [aliceList, await listOf(mallory)]
      }),
      'ambiguous-signer'
    );
  });

  it('validates its options', async () => {
    const alice = await author('alice', 1);
    const [signed] = await signedChain(alice.signers[0]!, [{}]);
    const list = await listOf(alice);
    await rejectsWith(
      verifyAuthoredEnvelope(signed!.envelope, signed!.signature, {
        deviceLists: [list, list]
      }),
      'invalid-argument'
    );
    expect(() => authorCutoffKey('a b', 'dev')).toThrow(E2eeError);
  });
});
