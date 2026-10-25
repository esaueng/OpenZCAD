import { describe, expect, it } from 'vitest';
import { concatBytes, type Bytes } from './bytes';
import { publicKeyHash } from './codes';
import {
  decodeGroupReset,
  encodeGroupReset,
  type SignedStatement
} from './devices';
import {
  decodeEncryptedDocumentBody,
  encodeEncryptedDocumentBody
} from './bodies';
import {
  EnvelopeKey,
  decryptProjectEnvelope,
  encryptProjectEnvelope
} from './envelope';
import { E2eeError, type E2eeErrorCode } from './errors';
import type { ProjectEnvelopeKind } from './header';
import { exportPublicKey, generateSigningKeyPair } from './keys';
import { generateSymmetricKey } from './primitives';
import {
  MAX_SHARE_AUTHORITY_LIFETIME_MS,
  MAX_SHARE_DELEGATION_LIFETIME_MS,
  SHARE_CLOCK_SKEW_MS,
  ShareLinkError,
  decodeShareAuthority,
  decodeShareDelegation,
  decodeShareLinkGrant,
  decodeShareLinkTombstone,
  encodeShareAuthority,
  encodeShareDelegation,
  encodeShareKeyWrap,
  encodeShareLinkGrant,
  encodeShareLinkTombstone,
  openShareKey,
  sameShareLinkSet,
  shareKeyHash,
  signShareAuthority,
  signShareDelegation,
  signShareKeyWrap,
  signShareLinkGrant,
  signShareLinkTombstone,
  verifyShareAuthority,
  verifyShareDelegation,
  verifyShareKeyWrap,
  verifyShareLinkSet,
  verifySharedSnapshot,
  type ShareAuthorityStatement,
  type ShareDelegation,
  type ShareLinkFailure,
  type ShareLinkGrant,
  type ShareLinkSet,
  type ShareLinkTombstone,
  type SharedSnapshotInput
} from './share-links';
import { signProjectEnvelope } from './signing';
import { patternBytes } from './test-support';
import { unwrapKey, wrapKey, wrapShareSnapshotKey } from './wrap';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_760_000_000_000;

interface Signer {
  readonly pair: CryptoKeyPair;
  readonly raw: Bytes;
  readonly hash: Bytes;
}

async function signer(): Promise<Signer> {
  const pair = await generateSigningKeyPair(false);
  const raw = await exportPublicKey(pair.publicKey);
  return { pair, raw, hash: await publicKeyHash(raw) };
}

async function refusedWith(
  promise: Promise<unknown>,
  reason: ShareLinkFailure
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(ShareLinkError);
  expect((error as ShareLinkError).reason).toBe(reason);
}

function throwsCode(run: () => unknown, code: E2eeErrorCode): void {
  expect(run).toThrow(
    expect.objectContaining({ name: 'E2eeError', code }) as unknown
  );
}

async function rejectsCode(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: 'E2eeError', code });
}

interface World {
  readonly identity: Signer;
  readonly ownerDevice: Signer;
  readonly otherOwnerDevice: Signer;
  readonly editorDevice: Signer;
  readonly stranger: Signer;
  readonly shareKey: Bytes;
  readonly shareKeyHash: Bytes;
  readonly delegation: ShareDelegation;
  readonly signedDelegation: SignedStatement;
  readonly authority: ShareAuthorityStatement;
  readonly signedAuthority: SignedStatement;
}

async function world(): Promise<World> {
  const [identity, ownerDevice, otherOwnerDevice, editorDevice, stranger] =
    await Promise.all([signer(), signer(), signer(), signer(), signer()]);
  const shareKey = generateSymmetricKey();
  const keyHash = await shareKeyHash(shareKey);
  const delegation: ShareDelegation = {
    identityKeyHash: identity.hash,
    sequence: 3,
    issuedAt: T0,
    expiresAt: T0 + 30 * DAY,
    deviceKeys: [ownerDevice.raw, otherOwnerDevice.raw]
  };
  const authority: ShareAuthorityStatement = {
    projectId: 'proj_1',
    shareId: 'share_1',
    shareKeyHash: keyHash,
    mode: 'tweak',
    ownerIdentityKeyHash: identity.hash,
    sequence: 7,
    issuedAt: T0 + DAY,
    expiresAt: T0 + 8 * DAY,
    signerKeyHash: ownerDevice.hash,
    authorKeyHashes: [editorDevice.hash, ownerDevice.hash]
  };
  return {
    identity,
    ownerDevice,
    otherOwnerDevice,
    editorDevice,
    stranger,
    shareKey,
    shareKeyHash: keyHash,
    delegation,
    signedDelegation: await signShareDelegation(
      identity.pair.privateKey,
      delegation
    ),
    authority,
    signedAuthority: await signShareAuthority(
      ownerDevice.pair.privateKey,
      authority
    )
  };
}

describe('share delegations', () => {
  it('round-trips, sorts its keys and verifies under the identity key', async () => {
    const w = await world();
    const bytes = encodeShareDelegation(w.delegation);
    const decoded = decodeShareDelegation(bytes);
    expect(decoded.sequence).toBe(3);
    // Keys are written sorted, whatever order they came in.
    const reversed = encodeShareDelegation({
      ...w.delegation,
      deviceKeys: [...w.delegation.deviceKeys].reverse()
    });
    expect(reversed).toEqual(bytes);
    const verified = await verifyShareDelegation(
      w.signedDelegation,
      w.identity.raw,
      { now: T0 + 2 * DAY, ownerIdentityKeyHash: w.identity.hash }
    );
    expect(verified.deviceKeys).toHaveLength(2);
  });

  it('lasts at most 30 days', async () => {
    const w = await world();
    const long = { ...w.delegation, expiresAt: T0 + 30 * DAY + 1 };
    throwsCode(() => encodeShareDelegation(long), 'invalid-argument');
    throwsCode(
      () =>
        encodeShareDelegation({
          ...w.delegation,
          expiresAt: w.delegation.issuedAt
        }),
      'invalid-argument'
    );
    expect(MAX_SHARE_DELEGATION_LIFETIME_MS).toBe(30 * DAY);
    // Bytes claiming a longer life (hand-built, then signed) are malformed.
    const bytes = encodeShareDelegation(w.delegation);
    const view = new DataView(bytes.buffer);
    // expiresAt sits after "OZS" | 1 | hash | u32 | u64 issuedAt.
    const at = 3 + 1 + 32 + 4 + 8;
    view.setUint32(at + 4, view.getUint32(at + 4) + 1);
    throwsCode(() => decodeShareDelegation(bytes), 'malformed');
  });

  it('refuses an expired delegation and one issued in the future', async () => {
    const w = await world();
    await refusedWith(
      verifyShareDelegation(w.signedDelegation, w.identity.raw, {
        now: w.delegation.expiresAt
      }),
      'delegation-expired'
    );
    await refusedWith(
      verifyShareDelegation(w.signedDelegation, w.identity.raw, {
        now: T0 - SHARE_CLOCK_SKEW_MS - 1
      }),
      'delegation-not-yet-valid'
    );
    // Within the clock skew is fine.
    await verifyShareDelegation(w.signedDelegation, w.identity.raw, {
      now: T0 - SHARE_CLOCK_SKEW_MS
    });
  });

  it('refuses a forged signer and another owner', async () => {
    const w = await world();
    // Signed by an owner device, not the identity, for the same identity.
    const forged = await signShareDelegation(
      w.ownerDevice.pair.privateKey,
      w.delegation
    );
    await refusedWith(
      verifyShareDelegation(forged, w.identity.raw, { now: T0 + DAY }),
      'delegation-signature'
    );
    // A stranger's identity cannot pass for the link owner.
    const strangers = await signShareDelegation(w.stranger.pair.privateKey, {
      ...w.delegation,
      identityKeyHash: w.stranger.hash
    });
    await refusedWith(
      verifyShareDelegation(strangers, w.stranger.raw, {
        now: T0 + DAY,
        ownerIdentityKeyHash: w.identity.hash
      }),
      'owner-mismatch'
    );
    // A delegation naming another identity than the key that signed it.
    await refusedWith(
      verifyShareDelegation(w.signedDelegation, w.stranger.raw, {
        now: T0 + DAY
      }),
      'owner-mismatch'
    );
  });

  it('refuses non-canonical bytes', async () => {
    const w = await world();
    const bytes = encodeShareDelegation(w.delegation);
    // Unsorted keys.
    const keysAt = bytes.byteLength - 2 * 65;
    const swapped = concatBytes(
      bytes.subarray(0, keysAt),
      bytes.subarray(keysAt + 65),
      bytes.subarray(keysAt, keysAt + 65)
    );
    throwsCode(() => decodeShareDelegation(swapped), 'malformed');
    // A duplicated key.
    const duplicated = concatBytes(
      bytes.subarray(0, keysAt),
      bytes.subarray(keysAt, keysAt + 65),
      bytes.subarray(keysAt, keysAt + 65)
    );
    throwsCode(() => decodeShareDelegation(duplicated), 'malformed');
    throwsCode(
      () => decodeShareDelegation(concatBytes(bytes, Uint8Array.of(0))),
      'malformed'
    );
    const newer = new Uint8Array(bytes);
    newer[3] = 2;
    throwsCode(() => decodeShareDelegation(newer), 'unsupported-version');
  });
});

describe('share-authority statements', () => {
  it('round-trips and verifies under a delegated owner device', async () => {
    const w = await world();
    const decoded = decodeShareAuthority(encodeShareAuthority(w.authority));
    expect(decoded.mode).toBe('tweak');
    const verified = await verifyShareAuthority(
      w.signedAuthority,
      w.delegation,
      {
        now: T0 + 2 * DAY,
        expected: {
          projectId: 'proj_1',
          shareId: 'share_1',
          shareKeyHash: w.shareKeyHash
        }
      }
    );
    expect(verified.sequence).toBe(7);
  });

  it('lasts at most 7 days', async () => {
    const w = await world();
    expect(MAX_SHARE_AUTHORITY_LIFETIME_MS).toBe(7 * DAY);
    throwsCode(
      () =>
        encodeShareAuthority({
          ...w.authority,
          expiresAt: w.authority.issuedAt + 7 * DAY + 1
        }),
      'invalid-argument'
    );
  });

  it('refuses an expired statement and one issued in the future', async () => {
    const w = await world();
    await refusedWith(
      verifyShareAuthority(w.signedAuthority, w.delegation, {
        now: w.authority.expiresAt
      }),
      'authority-expired'
    );
    await refusedWith(
      verifyShareAuthority(w.signedAuthority, w.delegation, {
        now: w.authority.issuedAt - SHARE_CLOCK_SKEW_MS - 1
      }),
      'authority-not-yet-valid'
    );
  });

  it('refuses a forged signer', async () => {
    const w = await world();
    // Signed by an editor device that the delegation does not name.
    const byEditor = await signShareAuthority(w.editorDevice.pair.privateKey, {
      ...w.authority,
      signerKeyHash: w.editorDevice.hash
    });
    await refusedWith(
      verifyShareAuthority(byEditor, w.delegation, { now: T0 + 2 * DAY }),
      'signer-not-delegated'
    );
    // Claims a delegated device but is signed by another key.
    const claimed = await signShareAuthority(
      w.stranger.pair.privateKey,
      w.authority
    );
    await refusedWith(
      verifyShareAuthority(claimed, w.delegation, { now: T0 + 2 * DAY }),
      'authority-signature'
    );
    // The other delegated device signing in its own name is fine.
    const byOther = await signShareAuthority(
      w.otherOwnerDevice.pair.privateKey,
      { ...w.authority, signerKeyHash: w.otherOwnerDevice.hash }
    );
    await verifyShareAuthority(byOther, w.delegation, { now: T0 + 2 * DAY });
    // A statement for another owner.
    const otherOwner = await signShareAuthority(w.ownerDevice.pair.privateKey, {
      ...w.authority,
      ownerIdentityKeyHash: w.stranger.hash
    });
    await refusedWith(
      verifyShareAuthority(otherOwner, w.delegation, { now: T0 + 2 * DAY }),
      'owner-mismatch'
    );
  });

  it('refuses a statement for another link', async () => {
    const w = await world();
    for (const expected of [
      { projectId: 'proj_2' },
      { shareId: 'share_2' },
      { shareKeyHash: patternBytes(32) }
    ]) {
      await refusedWith(
        verifyShareAuthority(w.signedAuthority, w.delegation, {
          now: T0 + 2 * DAY,
          expected
        }),
        'link-mismatch'
      );
    }
  });

  it('keeps each statement kind apart', async () => {
    const w = await world();
    // A grant signature over the same bytes is not an authority signature.
    const statement = encodeShareAuthority(w.authority);
    const asGrant = await signShareLinkGrant(w.ownerDevice.pair.privateKey, {
      projectId: 'proj_1',
      shareId: 'share_1',
      shareKeyHash: w.shareKeyHash,
      mode: 'view',
      keyEpoch: 0,
      issuedAt: T0,
      signerKeyHash: w.ownerDevice.hash
    });
    await refusedWith(
      verifyShareAuthority(
        { statement, signature: asGrant.signature },
        w.delegation,
        { now: T0 + 2 * DAY }
      ),
      'authority-signature'
    );
  });

  it('refuses non-canonical bytes', async () => {
    const w = await world();
    const bytes = encodeShareAuthority(w.authority);
    // Swap the two (sorted) author hashes.
    const at = bytes.byteLength - 64;
    const swapped = concatBytes(
      bytes.subarray(0, at),
      bytes.subarray(at + 32),
      bytes.subarray(at, at + 32)
    );
    throwsCode(() => decodeShareAuthority(swapped), 'malformed');
    // An unknown mode code.
    const mode = new Uint8Array(bytes);
    const modeAt = 3 + 1 + 1 + 'proj_1'.length + 1 + 'share_1'.length + 32;
    expect(mode[modeAt]).toBe(2);
    mode[modeAt] = 3;
    throwsCode(() => decodeShareAuthority(mode), 'malformed');
    throwsCode(
      () => decodeShareAuthority(concatBytes(bytes, Uint8Array.of(0))),
      'malformed'
    );
  });
});

async function snapshotEnvelope(
  options: {
    readonly kind?: ProjectEnvelopeKind;
    readonly projectId?: string;
  } = {}
): Promise<{ envelope: Bytes; versionKey: Bytes; plaintext: Bytes }> {
  const key = EnvelopeKey.generate();
  const versionKey = key.bytes;
  const kind = options.kind ?? 'share-snapshot';
  const plaintext = encodeEncryptedDocumentBody(
    {
      document: { name: 'Bracket' },
      blobs: [],
      revisionVersionHashes: new Map()
    },
    { kind, keyEpoch: 2, blobIds: [] }
  );
  const envelope = await encryptProjectEnvelope(
    key,
    {
      kind,
      projectId: options.projectId ?? 'proj_1',
      documentVersion: 9,
      previousVersionHash: null,
      epochBindingHash: patternBytes(32),
      schemaVersion: 1,
      keyEpoch: 2
    },
    plaintext
  );
  return { envelope, versionKey, plaintext };
}

describe('a link visitor checks a snapshot', () => {
  async function input(
    w: World,
    overrides: Partial<SharedSnapshotInput> = {},
    author: Signer = w.editorDevice
  ): Promise<SharedSnapshotInput> {
    const { envelope } = await snapshotEnvelope();
    return {
      ownerIdentityKeyHash: w.identity.hash,
      shareKey: w.shareKey,
      ownerIdentityKey: w.identity.raw,
      delegation: w.signedDelegation,
      authority: w.signedAuthority,
      snapshot: envelope,
      snapshotSignature: await signProjectEnvelope(
        author.pair.privateKey,
        envelope,
        T0 + 2 * DAY
      ),
      authorKey: author.raw,
      now: T0 + 3 * DAY,
      ...overrides
    };
  }

  it('accepts a snapshot every link of the chain vouches for, then decrypts it', async () => {
    const w = await world();
    const { envelope, versionKey, plaintext } = await snapshotEnvelope();
    const projectKey = generateSymmetricKey();
    const wraps = await wrapShareSnapshotKey(
      projectKey,
      w.shareKey,
      versionKey,
      {
        projectId: 'proj_1',
        keyEpoch: 2,
        shareId: 'share_1',
        versionId: '9'
      }
    );
    const verified = await verifySharedSnapshot({
      ...(await input(w)),
      snapshot: envelope,
      snapshotSignature: await signProjectEnvelope(
        w.editorDevice.pair.privateKey,
        envelope,
        T0 + 2 * DAY
      )
    });
    expect(verified).toMatchObject({
      projectId: 'proj_1',
      shareId: 'share_1',
      mode: 'tweak',
      signedAt: T0 + 2 * DAY
    });
    expect(verified.authorKeyHash).toEqual(w.editorDevice.hash);
    // Then the visitor opens the version key with the share key alone.
    const opened = await unwrapKey(w.shareKey, wraps.forLinkVisitors, {
      purpose: 'share-version-key',
      projectId: verified.projectId,
      keyEpoch: verified.header.keyEpoch,
      shareId: verified.shareId,
      versionId: String(verified.header.documentVersion)
    });
    const { plaintext: body } = await decryptProjectEnvelope(opened, envelope, {
      expect: { projectId: 'proj_1', kind: 'share-snapshot' }
    });
    expect(body).toEqual(plaintext);
  });

  it('refuses the wrong owner hash in the link', async () => {
    const w = await world();
    await refusedWith(
      verifySharedSnapshot(
        await input(w, { ownerIdentityKeyHash: w.stranger.hash })
      ),
      'owner-mismatch'
    );
  });

  it('refuses an expired delegation or statement', async () => {
    const w = await world();
    await refusedWith(
      verifySharedSnapshot(await input(w, { now: T0 + 30 * DAY })),
      'delegation-expired'
    );
    await refusedWith(
      verifySharedSnapshot(await input(w, { now: T0 + 8 * DAY })),
      'authority-expired'
    );
  });

  it('refuses a statement from an undelegated device', async () => {
    const w = await world();
    const narrower = await signShareDelegation(w.identity.pair.privateKey, {
      ...w.delegation,
      deviceKeys: [w.otherOwnerDevice.raw]
    });
    await refusedWith(
      verifySharedSnapshot(await input(w, { delegation: narrower })),
      'signer-not-delegated'
    );
  });

  it('refuses a statement for another link key', async () => {
    const w = await world();
    await refusedWith(
      verifySharedSnapshot(
        await input(w, { shareKey: generateSymmetricKey() })
      ),
      'link-mismatch'
    );
  });

  it('refuses a snapshot by an author the statement does not name', async () => {
    const w = await world();
    await refusedWith(
      verifySharedSnapshot(await input(w, {}, w.stranger)),
      'author-not-named'
    );
    // A named author's key with someone else's signature.
    const named = await input(w);
    const forged = await input(w, {}, w.stranger);
    await refusedWith(
      verifySharedSnapshot({
        ...named,
        snapshotSignature: forged.snapshotSignature,
        snapshot: forged.snapshot
      }),
      'snapshot-signature'
    );
  });

  it('refuses a snapshot of another project or another kind', async () => {
    const w = await world();
    for (const options of [
      { projectId: 'proj_2' },
      { kind: 'document' as const }
    ]) {
      const { envelope } = await snapshotEnvelope(options);
      await refusedWith(
        verifySharedSnapshot(
          await input(w, {
            snapshot: envelope,
            snapshotSignature: await signProjectEnvelope(
              w.editorDevice.pair.privateKey,
              envelope,
              T0 + 2 * DAY
            )
          })
        ),
        'snapshot-mismatch'
      );
    }
  });

  it('checks the copy it was given, not a caller array edited meanwhile', async () => {
    const w = await world();
    const value = await input(w);
    const ownerHash = new Uint8Array(value.ownerIdentityKeyHash);
    const pending = verifySharedSnapshot({
      ...value,
      ownerIdentityKeyHash: ownerHash
    });
    ownerHash.fill(0);
    await expect(pending).resolves.toMatchObject({ shareId: 'share_1' });
  });
});

describe('link grants and tombstones', () => {
  const grant = (w: World, overrides: Partial<ShareLinkGrant> = {}) =>
    ({
      projectId: 'proj_1',
      shareId: 'share_1',
      shareKeyHash: w.shareKeyHash,
      mode: 'view',
      keyEpoch: 2,
      issuedAt: T0,
      signerKeyHash: w.ownerDevice.hash,
      ...overrides
    }) satisfies ShareLinkGrant;
  const tombstone = (w: World, overrides: Partial<ShareLinkTombstone> = {}) =>
    ({
      projectId: 'proj_1',
      shareId: 'share_0',
      keyEpoch: 1,
      issuedAt: T0,
      signerKeyHash: w.ownerDevice.hash,
      ...overrides
    }) satisfies ShareLinkTombstone;

  async function linkSet(
    w: World,
    grants: ShareLinkGrant[],
    tombstones: ShareLinkTombstone[],
    by: Signer = w.ownerDevice
  ): Promise<ShareLinkSet> {
    return {
      grants: await Promise.all(
        grants.map((g) => signShareLinkGrant(by.pair.privateKey, g))
      ),
      tombstones: await Promise.all(
        tombstones.map((t) => signShareLinkTombstone(by.pair.privateKey, t))
      )
    };
  }

  const owner = (w: World) => ({
    projectId: 'proj_1',
    keyEpoch: 3,
    resolveOwnerKey: ({ signerKeyHash }: { signerKeyHash: Uint8Array }) =>
      [w.ownerDevice, w.otherOwnerDevice].find((d) =>
        d.hash.every((byte, i) => byte === signerKeyHash[i])
      )?.raw ?? null
  });

  it('round-trip canonically', async () => {
    const w = await world();
    const g = grant(w);
    expect(decodeShareLinkGrant(encodeShareLinkGrant(g))).toEqual(g);
    const t = tombstone(w);
    expect(decodeShareLinkTombstone(encodeShareLinkTombstone(t))).toEqual(t);
    for (const bytes of [
      encodeShareLinkGrant(g),
      encodeShareLinkTombstone(t)
    ]) {
      const decode =
        bytes[2] === 0x4c ? decodeShareLinkGrant : decodeShareLinkTombstone;
      throwsCode(
        () => decode(concatBytes(bytes, Uint8Array.of(1))),
        'malformed'
      );
      throwsCode(() => decode(bytes.subarray(0, -1)), 'malformed');
    }
    throwsCode(
      () => encodeShareLinkGrant({ ...g, keyEpoch: -1 }),
      'invalid-argument'
    );
    throwsCode(
      () => encodeShareLinkTombstone({ ...t, shareId: 'with space' }),
      'invalid-argument'
    );
    // A grant's bytes are not a tombstone, nor the reverse.
    throwsCode(
      () => decodeShareLinkTombstone(encodeShareLinkGrant(g)),
      'malformed'
    );
    // Nor is a solo group reset (4-10), which once shared the "OZX" magic.
    const reset = encodeGroupReset({
      userId: 'user_1',
      generation: 1,
      entrySequence: 0,
      entryHash: patternBytes(32, 7),
      projectId: t.projectId,
      priorGroupGeneration: 0,
      priorKeyEpoch: 1,
      issuedAt: t.issuedAt
    });
    const tombstoneBytes = encodeShareLinkTombstone(t);
    expect([...tombstoneBytes.subarray(0, 3)]).not.toEqual([
      ...reset.subarray(0, 3)
    ]);
    throwsCode(() => decodeShareLinkTombstone(reset), 'malformed');
    throwsCode(() => decodeGroupReset(tombstoneBytes), 'malformed');
  });

  it('accept an owner-signed set and return its active links', async () => {
    const w = await world();
    const set = await linkSet(
      w,
      [grant(w, { shareId: 'share_2' }), grant(w)],
      [tombstone(w)]
    );
    const body = encodeEncryptedDocumentBody(
      {
        document: {},
        blobs: [],
        revisionVersionHashes: new Map(),
        shareLinks: set
      },
      { kind: 'document', keyEpoch: 3, blobIds: [] }
    );
    const decoded = decodeEncryptedDocumentBody(body, {
      kind: 'document',
      keyEpoch: 3,
      blobIds: []
    });
    const verified = await verifyShareLinkSet(decoded.shareLinks!, owner(w));
    expect(verified.links.map((l) => l.shareId)).toEqual([
      'share_1',
      'share_2'
    ]);
    expect([...verified.tombstonedIds]).toEqual(['share_0']);
    expect(sameShareLinkSet(verified.set, decoded.shareLinks!)).toBe(true);
  });

  it('refuse a tombstoned link', async () => {
    const w = await world();
    const set = await linkSet(w, [grant(w)], []);
    await refusedWith(
      verifyShareLinkSet(set, { ...owner(w), seenTombstones: ['share_1'] }),
      'tombstoned'
    );
    const both = await linkSet(
      w,
      [grant(w)],
      [tombstone(w, { shareId: 'share_1' })]
    );
    await refusedWith(verifyShareLinkSet(both, owner(w)), 'tombstoned');
  });

  it('refuse a grant for another project or a later epoch', async () => {
    const w = await world();
    for (const overrides of [{ projectId: 'proj_2' }, { keyEpoch: 4 }]) {
      await refusedWith(
        verifyShareLinkSet(
          await linkSet(w, [grant(w, overrides)], []),
          owner(w)
        ),
        'grant-mismatch'
      );
      await refusedWith(
        verifyShareLinkSet(
          await linkSet(w, [], [tombstone(w, overrides)]),
          owner(w)
        ),
        'grant-mismatch'
      );
    }
  });

  it('refuse a forged or unknown signer', async () => {
    const w = await world();
    // Names the owner device, signed by a stranger.
    await refusedWith(
      verifyShareLinkSet(
        await linkSet(w, [grant(w)], [], w.stranger),
        owner(w)
      ),
      'grant-signature'
    );
    await refusedWith(
      verifyShareLinkSet(
        await linkSet(w, [], [tombstone(w)], w.stranger),
        owner(w)
      ),
      'tombstone-signature'
    );
    // Names a key the owner's devices do not include.
    await refusedWith(
      verifyShareLinkSet(
        await linkSet(
          w,
          [grant(w, { signerKeyHash: w.editorDevice.hash })],
          [],
          w.editorDevice
        ),
        owner(w)
      ),
      'unknown-signer'
    );
    // A resolver that answers with another key than the one named.
    await refusedWith(
      verifyShareLinkSet(await linkSet(w, [grant(w)], []), {
        ...owner(w),
        resolveOwnerKey: () => w.otherOwnerDevice.raw
      }),
      'unknown-signer'
    );
  });

  it('never drop a tombstone, and let only the owner change the set', async () => {
    const w = await world();
    const parentSet = await linkSet(w, [grant(w)], [tombstone(w)]);
    const previous = await verifyShareLinkSet(parentSet, owner(w));
    // An editor carries the set forward unchanged.
    await verifyShareLinkSet(parentSet, {
      ...owner(w),
      previous,
      authorIsOwner: false
    });
    const revoked = await linkSet(
      w,
      [],
      [tombstone(w), tombstone(w, { shareId: 'share_1', keyEpoch: 3 })]
    );
    // The owner revokes share_1.
    const after = await verifyShareLinkSet(revoked, {
      ...owner(w),
      previous,
      authorIsOwner: true
    });
    expect(after.links).toEqual([]);
    // An editor may not change it, either way.
    await refusedWith(
      verifyShareLinkSet(revoked, {
        ...owner(w),
        previous,
        authorIsOwner: false
      }),
      'changed-by-editor'
    );
    // Not even the owner drops a tombstone: share_1 cannot come back.
    await refusedWith(
      verifyShareLinkSet(parentSet, {
        ...owner(w),
        previous: after,
        authorIsOwner: true
      }),
      'tombstone-dropped'
    );
    await rejectsCode(
      verifyShareLinkSet(parentSet, { ...owner(w), previous }),
      'invalid-argument'
    );
  });

  it('refuse an unsorted or duplicated set', async () => {
    const w = await world();
    const set = await linkSet(
      w,
      [grant(w), grant(w, { shareId: 'share_2' })],
      []
    );
    await rejectsCode(
      verifyShareLinkSet(
        { ...set, grants: [...set.grants].reverse() },
        owner(w)
      ),
      'invalid-argument'
    );
    await rejectsCode(
      verifyShareLinkSet(
        { ...set, grants: [set.grants[0]!, set.grants[0]!] },
        owner(w)
      ),
      'invalid-argument'
    );
  });
});

describe('share keys', () => {
  it('opens a share key only for its link, epoch and grant hash', async () => {
    const w = await world();
    const projectKey = generateSymmetricKey();
    const context = { projectId: 'proj_1', keyEpoch: 2, shareId: 'share_1' };
    const wrapped = await wrapKey(projectKey, w.shareKey, {
      purpose: 'share-key',
      ...context
    });
    expect(
      await openShareKey(projectKey, wrapped, context, w.shareKeyHash)
    ).toEqual(w.shareKey);
    await rejectsCode(
      openShareKey(projectKey, wrapped, context, patternBytes(32)),
      'context-mismatch'
    );
    // Each epoch has its own wrap: the epoch is bound.
    await rejectsCode(
      openShareKey(
        projectKey,
        wrapped,
        { ...context, keyEpoch: 3 },
        w.shareKeyHash
      ),
      'authentication-failed'
    );
    await rejectsCode(
      openShareKey(
        projectKey,
        wrapped,
        { ...context, shareId: 'share_2' },
        w.shareKeyHash
      ),
      'authentication-failed'
    );
    await expect(shareKeyHash(patternBytes(31))).rejects.toBeInstanceOf(
      E2eeError
    );
  });

  it('signs a stored wrap for one device, link, epoch and exact bytes', async () => {
    const w = await world();
    const value = {
      projectId: 'proj_1',
      shareId: 'share_1',
      keyEpoch: 4,
      wrapped: patternBytes(41)
    };
    // "OZW" | 1 | u8 6 "proj_1" | u8 7 "share_1" | u32 4 | u8 41 + wrap
    const encoded = encodeShareKeyWrap(value);
    expect(encoded.subarray(0, 4)).toEqual(Uint8Array.of(0x4f, 0x5a, 0x57, 1));
    expect(encoded.byteLength).toBe(4 + 7 + 8 + 4 + 42);
    const signature = await signShareKeyWrap(
      w.editorDevice.pair.privateKey,
      value
    );
    expect(signature.byteLength).toBe(65);
    expect(await verifyShareKeyWrap(w.editorDevice.raw, value, signature)).toBe(
      true
    );
    // Another device, link, epoch or wrap: not this signature.
    expect(await verifyShareKeyWrap(w.stranger.raw, value, signature)).toBe(
      false
    );
    for (const changed of [
      { ...value, shareId: 'share_2' },
      { ...value, projectId: 'proj_2' },
      { ...value, keyEpoch: 5 },
      { ...value, wrapped: patternBytes(41, 7) }
    ]) {
      expect(
        await verifyShareKeyWrap(w.editorDevice.raw, changed, signature)
      ).toBe(false);
    }
    // Another statement kind's signature does not count.
    const grant = await signShareLinkGrant(w.editorDevice.pair.privateKey, {
      projectId: 'proj_1',
      shareId: 'share_1',
      shareKeyHash: w.shareKeyHash,
      mode: 'view',
      keyEpoch: 4,
      issuedAt: T0,
      signerKeyHash: w.editorDevice.hash
    });
    expect(
      await verifyShareKeyWrap(w.editorDevice.raw, value, grant.signature)
    ).toBe(false);
    throwsCode(
      () => encodeShareKeyWrap({ ...value, wrapped: new Uint8Array(0) }),
      'invalid-argument'
    );
    throwsCode(
      () => encodeShareKeyWrap({ ...value, keyEpoch: -1 }),
      'invalid-argument'
    );
  });
});
