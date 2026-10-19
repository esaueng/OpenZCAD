import { describe, expect, it } from 'vitest';
import { concatBytes, equalBytes, type Bytes } from './bytes';
import {
  assetDedupeHash,
  commitDeviceApproval,
  createApprovalNonce,
  deriveAssetDedupeKey,
  deviceApprovalCode,
  formatComparisonCode,
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
  projectStateCode,
  publicKeyHash,
  verifyDeviceApprovalCommitment,
  verifyScannedDeviceKey
} from './codes';
import type { VerifiedDeviceList } from './devices';
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
  generateIdentityKeyPair
} from './keys';
import {
  decodeRosterEntry,
  encodeRosterEntry,
  readRosterSigner,
  rosterEntryHash,
  signProjectEnvelope,
  signRosterEntry,
  verifyProjectEnvelopeSignature,
  verifyRosterChain,
  verifyVersionChain,
  versionHash,
  type RosterEntry,
  type RosterMember,
  type SignedRosterEntry
} from './signing';
import { TestUser, patternBytes } from './test-support';
import { sealKey } from './wrap';

async function rejectsWith(
  promise: Promise<unknown>,
  code: E2eeErrorCode
): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof E2eeError && error.code === code
  );
}

const header = (
  documentVersion: number,
  previous: Uint8Array | null,
  change: Partial<ProjectEnvelopeHeaderInit> = {}
): ProjectEnvelopeHeaderInit => ({
  kind: 'document',
  projectId: 'project-a',
  documentVersion,
  previousVersionHash: previous,
  rosterEntryHash: patternBytes(32, 0xb0),
  schemaVersion: 23,
  keyEpoch: 1,
  chunkSize: 64,
  ...change
});

async function version(
  documentVersion: number,
  previous: Uint8Array | null,
  change: Partial<ProjectEnvelopeHeaderInit> = {}
): Promise<Bytes> {
  return encryptProjectEnvelope(
    EnvelopeKey.generate(),
    header(documentVersion, previous, change),
    patternBytes(100, documentVersion)
  );
}

async function chainOf(length: number): Promise<Bytes[]> {
  const chain: Bytes[] = [];
  for (let v = 1; v <= length; v += 1) {
    const previous = chain.at(-1);
    chain.push(await version(v, previous ? await versionHash(previous) : null));
  }
  return chain;
}

describe('version signatures', () => {
  it('are made by a certified device key, with a timestamp', async () => {
    const author = await TestUser.create('author', ['laptop']);
    const envelope = await version(1, null);
    const signature = await signProjectEnvelope(
      author.signer(),
      envelope,
      1_760_000_000_000
    );
    expect(
      await verifyProjectEnvelopeSignature(author.list, envelope, signature)
    ).toMatchObject({
      userId: 'author',
      deviceId: 'laptop',
      deviceListSequence: 0,
      signedAt: 1_760_000_000_000
    });
  });

  it('cover the header and the ciphertext', async () => {
    const author = await TestUser.create('author');
    const envelope = await version(3, null);
    const signature = await signProjectEnvelope(author.signer(), envelope);
    const changedBody = new Uint8Array(envelope);
    changedBody[changedBody.byteLength - 1]! ^= 1;
    expect(
      await verifyProjectEnvelopeSignature(author.list, changedBody, signature)
    ).toBeNull();
    const changedHeader = new Uint8Array(envelope);
    changedHeader[22]! ^= 1; // low byte of keyEpoch
    expect(
      await verifyProjectEnvelopeSignature(
        author.list,
        changedHeader,
        signature
      )
    ).toBeNull();
    for (const fill of [0x00, 0xff]) {
      const outOfRange = new Uint8Array(signature);
      outOfRange.fill(fill, outOfRange.byteLength - 64);
      expect(
        await verifyProjectEnvelopeSignature(author.list, envelope, outOfRange)
      ).toBeNull();
    }
  });

  it('from a revoked device count only within the cutoff', async () => {
    const author = await TestUser.create('author', ['laptop', 'stolen']);
    const v1 = await version(1, null);
    const v2 = await version(2, await versionHash(v1));
    const v3 = await version(3, await versionHash(v2));
    const signed = await Promise.all(
      [v1, v2, v3].map((v) => signProjectEnvelope(author.signer('stolen'), v))
    );
    // The revoking browser had accepted up to version 2.
    await author.revoke('stolen', [
      {
        projectId: 'project-a',
        versionHead: await versionHash(v2),
        rosterHead: null
      }
    ]);
    const history = await verifyVersionChain([v1, v2, v3]);
    const isAncestorOrSelf = (candidate: Uint8Array, head: Uint8Array) => {
      const at = history.findIndex((h) => equalBytes(h, candidate));
      const headAt = history.findIndex((h) => equalBytes(h, head));
      return at >= 0 && at <= headAt;
    };
    for (const [envelope, signature] of [
      [v1, signed[0]!],
      [v2, signed[1]!]
    ] as const) {
      expect(
        await verifyProjectEnvelopeSignature(author.list, envelope, signature, {
          isAncestorOrSelf
        })
      ).not.toBeNull();
    }
    await rejectsWith(
      verifyProjectEnvelopeSignature(author.list, v3, signed[2]!, {
        isAncestorOrSelf
      }),
      'key-revoked'
    );
    // Without an ancestry lookup a revoked device is always refused.
    await rejectsWith(
      verifyProjectEnvelopeSignature(author.list, v1, signed[0]!),
      'key-revoked'
    );
  });

  it('refuse content blobs, malformed input and unknown versions', async () => {
    const author = await TestUser.create('author');
    const envelope = await version(1, null);
    const signature = await signProjectEnvelope(author.signer(), envelope);
    const future = new Uint8Array(signature);
    future[0] = 2;
    await rejectsWith(
      verifyProjectEnvelopeSignature(author.list, envelope, future),
      'unsupported-version'
    );
    await rejectsWith(
      verifyProjectEnvelopeSignature(
        author.list,
        envelope,
        signature.subarray(0, 72)
      ),
      'malformed'
    );
    await rejectsWith(
      verifyProjectEnvelopeSignature(author.list, patternBytes(40), signature),
      'malformed'
    );
    await rejectsWith(
      signProjectEnvelope(author.signer(), envelope, -1),
      'invalid-argument'
    );
    const { envelope: blob } = await encryptContentBlob(
      EnvelopeKey.generate(),
      'thumbnail',
      patternBytes(5)
    );
    await rejectsWith(
      signProjectEnvelope(author.signer(), blob),
      'invalid-argument'
    );
  });
});

describe('version chains', () => {
  it('accepts an unbroken history that contains the pin', async () => {
    const chain = await chainOf(4);
    const hashes = await verifyVersionChain(chain);
    expect(hashes).toHaveLength(4);
    expect(
      await verifyVersionChain(chain, { pinnedVersionHash: hashes[2]! })
    ).toEqual(hashes);
    await verifyVersionChain(chain.slice(1), { pinnedVersionHash: hashes[1]! });
  });

  it('refuses rollback, forks and broken links', async () => {
    const chain = await chainOf(3);
    const hashes = await verifyVersionChain(chain);
    await rejectsWith(
      verifyVersionChain(chain.slice(0, 2), { pinnedVersionHash: hashes[2]! }),
      'chain-broken'
    );
    const sibling = await version(3, hashes[1]!);
    await rejectsWith(
      verifyVersionChain([chain[0]!, chain[1]!, sibling], {
        pinnedVersionHash: hashes[2]!
      }),
      'chain-broken'
    );
    for (const broken of [
      [chain[0]!, chain[2]!],
      [chain[1]!, chain[0]!],
      [chain[0]!, await version(2, hashes[0]!, { projectId: 'project-b' })],
      [chain[0]!, await version(1, hashes[0]!)],
      [chain[0]!, await version(2, null)]
    ]) {
      await rejectsWith(verifyVersionChain(broken), 'chain-broken');
    }
  });
});

describe('signed roster', () => {
  interface Fixture {
    owner: TestUser;
    editor: TestUser;
    viewer: TestUser;
    lists: (userId: string) => VerifiedDeviceList | undefined;
  }

  async function fixture(): Promise<Fixture> {
    const owner = await TestUser.create('owner-1');
    const editor = await TestUser.create('editor-1');
    const viewer = await TestUser.create('viewer-1');
    const byId = new Map([owner, editor, viewer].map((u) => [u.userId, u]));
    return { owner, editor, viewer, lists: (id) => byId.get(id)?.list };
  }

  async function memberOf(user: TestUser, role: RosterMember['role']) {
    return {
      userId: user.userId,
      identityKeyHash: user.list.identityKeyHash,
      role
    };
  }

  async function wrapsFor(users: TestUser[], keyEpoch: number) {
    return Promise.all(
      users.map(async (user) => ({
        userId: user.userId,
        sealedKey: await sealKey(
          user.encryptionKey,
          patternBytes(32, keyEpoch),
          {
            purpose: 'project-key',
            userId: user.userId,
            projectId: 'project-a',
            keyEpoch
          }
        )
      }))
    );
  }

  /** Owner creates the project, adds the editor, then the editor rotates. */
  async function history(f: Fixture): Promise<SignedRosterEntry[]> {
    const first: RosterEntry = {
      projectId: 'project-a',
      sequence: 0,
      keyEpoch: 1,
      previousEntryHash: null,
      members: [await memberOf(f.owner, 'owner')],
      keyWraps: await wrapsFor([f.owner], 1)
    };
    const s0 = await signRosterEntry(f.owner.signer(), first);
    const added: RosterEntry = {
      ...first,
      sequence: 1,
      previousEntryHash: await rosterEntryHash(s0.entry),
      members: [...first.members, await memberOf(f.editor, 'editor')],
      keyWraps: []
    };
    const s1 = await signRosterEntry(f.owner.signer(), added);
    const epoch: RosterEntry = {
      ...added,
      sequence: 2,
      keyEpoch: 2,
      previousEntryHash: await rosterEntryHash(s1.entry),
      keyWraps: await wrapsFor([f.owner, f.editor], 2)
    };
    const s2 = await signRosterEntry(f.editor.signer(), epoch);
    return [s0, s1, s2];
  }

  it('encodes canonically and round-trips', async () => {
    const f = await fixture();
    const [s0, s1] = await history(f);
    for (const signed of [s0!, s1!]) {
      const decoded = decodeRosterEntry(signed.entry);
      expect(encodeRosterEntry(decoded)).toEqual(signed.entry);
      expect(
        encodeRosterEntry({
          ...decoded,
          members: [...decoded.members].reverse()
        })
      ).toEqual(signed.entry);
    }
  });

  it('verifies device signatures, links, epochs and the pin', async () => {
    const f = await fixture();
    const chain = await history(f);
    expect(readRosterSigner(chain[2]!).userId).toBe('editor-1');
    const seen: string[] = [];
    const verified = await verifyRosterChain(chain, f.lists, {
      authorize: (entry, kind, signer) => {
        seen.push(`${entry.sequence}:${kind}:${signer.userId}`);
        return true;
      }
    });
    expect(seen).toEqual([
      '0:membership:owner-1',
      '1:membership:owner-1',
      '2:epoch:editor-1'
    ]);
    await verifyRosterChain(chain.slice(1), f.lists, {
      pinnedEntryHash: verified[2]!.hash
    });
  });

  it('refuses forged, broken, rolled-back or unauthorized chains', async () => {
    const f = await fixture();
    const chain = await history(f);
    const hashes = (await verifyRosterChain(chain, f.lists)).map((v) => v.hash);
    // A signer with no verified device list, or a device it never certified.
    await rejectsWith(
      verifyRosterChain(chain, (id) =>
        id === 'editor-1' ? undefined : f.lists(id)
      ),
      'authentication-failed'
    );
    const forged = await signRosterEntry(
      { ...f.viewer.signer(), userId: 'owner-1' },
      decodeRosterEntry(chain[0]!.entry)
    );
    await rejectsWith(
      verifyRosterChain([forged], f.lists),
      'authentication-failed'
    );
    // Bytes changed after signing.
    const tampered = new Uint8Array(chain[1]!.entry);
    tampered[60]! ^= 1;
    await expect(
      verifyRosterChain([chain[0]!, { ...chain[1]!, entry: tampered }], f.lists)
    ).rejects.toBeInstanceOf(E2eeError);
    await rejectsWith(
      verifyRosterChain([chain[0]!, chain[2]!], f.lists),
      'chain-broken'
    );
    await rejectsWith(
      verifyRosterChain([chain[1]!, chain[0]!], f.lists),
      'chain-broken'
    );
    await rejectsWith(
      verifyRosterChain(chain.slice(0, 2), f.lists, {
        pinnedEntryHash: hashes[2]!
      }),
      'chain-broken'
    );
    await rejectsWith(
      verifyRosterChain(chain.slice(1), f.lists),
      'chain-broken'
    );
    await rejectsWith(verifyRosterChain([], f.lists), 'chain-broken');
    // Phase 5's rule as a callback: the owner changes membership, any
    // member may start an epoch. A viewer adding themself is refused.
    const ownerRule = (
      entry: RosterEntry,
      kind: 'membership' | 'epoch',
      signer: { userId: string },
      previous: RosterEntry | null
    ): boolean =>
      kind === 'epoch'
        ? (previous ?? entry).members.some((m) => m.userId === signer.userId)
        : signer.userId === 'owner-1';
    await verifyRosterChain(chain, f.lists, { authorize: ownerRule });
    const epoch = decodeRosterEntry(chain[2]!.entry);
    const byViewer = await signRosterEntry(f.viewer.signer(), {
      ...epoch,
      members: [...epoch.members, await memberOf(f.viewer, 'editor')],
      keyWraps: await wrapsFor([f.owner, f.editor, f.viewer], 2)
    });
    await rejectsWith(
      verifyRosterChain([...chain.slice(0, 2), byViewer], f.lists, {
        authorize: ownerRule
      }),
      'authentication-failed'
    );
  });

  it('accepts entries from a since-revoked device only within its roster cutoff', async () => {
    const f = await fixture();
    const chain = await history(f);
    const hashes = (await verifyRosterChain(chain, f.lists)).map((v) => v.hash);
    // The editor's device signed entry 2, then was revoked with the cutoff
    // at entry 2: the chain still verifies.
    await f.editor.addDevice('spare');
    await f.editor.revoke('d1', [
      {
        projectId: 'project-a',
        versionHead: patternBytes(32),
        rosterHead: hashes[2]!
      }
    ]);
    await verifyRosterChain(chain, f.lists);
    // With the cutoff at entry 1, the editor's entry 2 is refused.
    const strict = await TestUser.create('editor-1');
    await strict.addDevice('spare');
    const signer = strict.signer('d1');
    const epoch = decodeRosterEntry(chain[2]!.entry);
    const resigned = await signRosterEntry(signer, epoch);
    await strict.revoke('d1', [
      {
        projectId: 'project-a',
        versionHead: patternBytes(32),
        rosterHead: hashes[1]!
      }
    ]);
    await rejectsWith(
      verifyRosterChain([chain[0]!, chain[1]!, resigned], (id) =>
        id === 'editor-1' ? strict.list : f.lists(id)
      ),
      'key-revoked'
    );
  });

  it('enforces epoch structure and key wraps', async () => {
    const f = await fixture();
    const chain = await history(f);
    const epoch = decodeRosterEntry(chain[2]!.entry);
    const owner = f.owner.signer();
    for (const bad of [
      { ...epoch, keyWraps: epoch.keyWraps.slice(0, 1) },
      {
        ...epoch,
        keyWraps: [
          ...epoch.keyWraps,
          { userId: 'stranger', sealedKey: patternBytes(10) }
        ]
      },
      { ...epoch, sequence: 0 },
      { ...epoch, members: [] },
      {
        ...epoch,
        members: [{ ...epoch.members[0]!, identityKeyHash: patternBytes(31) }]
      },
      { ...epoch, members: [{ ...epoch.members[0]!, role: 'admin' as never }] },
      {
        ...decodeRosterEntry(chain[0]!.entry),
        keyWraps: []
      }
    ]) {
      await rejectsWith(signRosterEntry(owner, bad), 'invalid-argument');
    }
    // An epoch that skips a number, or moves without wraps.
    const skip = await signRosterEntry(f.editor.signer(), {
      ...epoch,
      keyEpoch: 3
    });
    await rejectsWith(
      verifyRosterChain([...chain.slice(0, 2), skip], f.lists),
      'chain-broken'
    );
    const noWraps = await signRosterEntry(f.editor.signer(), {
      ...epoch,
      keyWraps: []
    });
    await rejectsWith(
      verifyRosterChain([...chain.slice(0, 2), noWraps], f.lists),
      'chain-broken'
    );
    // Non-canonical member order and future versions fail to decode.
    const future = new Uint8Array(chain[0]!.entry);
    future[3] = 2;
    expect(() => decodeRosterEntry(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    const truncated = concatBytes(chain[1]!.entry.subarray(0, 50));
    expect(() => decodeRosterEntry(truncated)).toThrow(E2eeError);
  });
});

describe('asset de-duplication', () => {
  it('is stable per project key and differs across keys', async () => {
    const content = patternBytes(1000, 3);
    const keyA = await deriveAssetDedupeKey(patternBytes(32, 1));
    const keyB = await deriveAssetDedupeKey(patternBytes(32, 2));
    const a1 = await assetDedupeHash(keyA, content);
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(await assetDedupeHash(keyA, new Uint8Array(content))).toBe(a1);
    expect(await assetDedupeHash(keyB, content)).not.toBe(a1);
  });
});

describe('codes people compare', () => {
  it('hashes keys in full and shows at least 128 bits', async () => {
    const enc = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    const sig = await exportPublicKey(
      (await generateIdentityKeyPair()).publicKey
    );
    const single = await publicKeyHash(enc);
    expect(single.byteLength).toBe(32);
    expect(await publicKeyHash([enc])).toEqual(single);
    const identity = await publicKeyHash([enc, sig]);
    expect(identity).not.toEqual(single);
    expect(await publicKeyHash([sig, enc])).not.toEqual(identity);
    const code = formatComparisonCode(identity);
    expect(code).toMatch(/^\d{5}( \d{5}){7}$/);
    expect(Math.log2(10) * code.replace(/ /g, '').length).toBeGreaterThan(128);
    await rejectsWith(publicKeyHash(enc.subarray(1)), 'invalid-argument');
    await rejectsWith(publicKeyHash([]), 'invalid-argument');
    expect(() => formatComparisonCode(identity.subarray(0, 16))).toThrow(
      E2eeError
    );
  });

  it('derives a project state code from version, hash and signer', async () => {
    const input = {
      versionHash: patternBytes(32, 1),
      documentVersion: 9,
      signerKeyHash: patternBytes(32, 2)
    };
    const { hash, code } = await projectStateCode(input);
    expect(code).toBe(formatComparisonCode(hash));
    for (const change of [
      { versionHash: patternBytes(32, 3) },
      { documentVersion: 10 },
      { signerKeyHash: patternBytes(32, 4) }
    ]) {
      expect((await projectStateCode({ ...input, ...change })).code).not.toBe(
        code
      );
    }
    await rejectsWith(
      projectStateCode({ ...input, versionHash: patternBytes(16) }),
      'invalid-argument'
    );
  });

  it('approves a device by scanning its full key hash', async () => {
    const device = await exportPublicKey(
      (await generateEncryptionKeyPair(false)).publicKey
    );
    const substitute = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    const scanned = await publicKeyHash(device);
    expect(await verifyScannedDeviceKey(device, scanned)).toBe(true);
    expect(await verifyScannedDeviceKey(substitute, scanned)).toBe(false);
  });

  it('runs the commitment-based comparison', async () => {
    const newDevicePublicKey = await exportPublicKey(
      (await generateEncryptionKeyPair(false)).publicKey
    );
    const approverPublicKey = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    // 1. The new device commits before it sees anything from the approver.
    const { nonce, commitment } =
      await commitDeviceApproval(newDevicePublicKey);
    // 2. The approver answers with its key and nonce; 3. the device reveals.
    const approverNonce = createApprovalNonce();
    expect(
      await verifyDeviceApprovalCommitment(
        newDevicePublicKey,
        nonce,
        commitment
      )
    ).toBe(true);
    const input = {
      newDevicePublicKey,
      approverPublicKey,
      newDeviceNonce: nonce,
      approverNonce
    };
    const code = await deviceApprovalCode(input);
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(await deviceApprovalCode({ ...input })).toBe(code);

    // A relay that substitutes a key cannot reuse the device's commitment.
    const relay = await exportPublicKey(
      (await generateEncryptionKeyPair()).publicKey
    );
    expect(await verifyDeviceApprovalCommitment(relay, nonce, commitment)).toBe(
      false
    );
    expect(
      await verifyDeviceApprovalCommitment(
        newDevicePublicKey,
        approverNonce,
        commitment
      )
    ).toBe(false);
    // Every input feeds the code.
    for (const change of [
      { newDevicePublicKey: relay },
      { approverPublicKey: relay },
      { newDeviceNonce: approverNonce },
      { approverNonce: nonce }
    ]) {
      expect(await deviceApprovalCode({ ...input, ...change })).not.toBe(code);
    }
    await rejectsWith(
      deviceApprovalCode({ ...input, newDeviceNonce: nonce.subarray(1) }),
      'invalid-argument'
    );
    await rejectsWith(
      deviceApprovalCode({ ...input, approverPublicKey: relay.subarray(1) }),
      'invalid-argument'
    );
  });
});

describe('recovery keys', () => {
  it('formats, parses and tolerates spacing, case and look-alikes', async () => {
    const { secret, formatted } = await generateRecoveryKey();
    expect(formatted).toMatch(
      /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/
    );
    expect(await parseRecoveryKey(formatted)).toEqual(secret);
    const sloppy = formatted
      .toLowerCase()
      .replace(/-/g, ' ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    expect(await parseRecoveryKey(sloppy)).toEqual(secret);
  });

  it('catches a mistyped character', async () => {
    const formatted = await formatRecoveryKey(patternBytes(32, 0x42));
    const first = formatted[0] === 'A' ? 'B' : 'A';
    await rejectsWith(
      parseRecoveryKey(first + formatted.slice(1)),
      'malformed'
    );
    await rejectsWith(parseRecoveryKey(formatted.slice(0, -1)), 'malformed');
    await rejectsWith(
      parseRecoveryKey(formatted.replace(/^./, 'U')),
      'malformed'
    );
  });
});
