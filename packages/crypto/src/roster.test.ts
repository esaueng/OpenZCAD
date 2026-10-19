import { describe, expect, it } from 'vitest';
import { equalBytes } from './bytes';
import { E2eeError, type E2eeErrorCode } from './errors';
import {
  acceptCurrentRoster,
  checkVersionEpoch,
  historicalRosterState,
  decodeRosterEntry,
  encodeRosterEntry,
  rosterEntryHash,
  signRosterEntry,
  signRosterEntryWithIdentity,
  verifyRosterChain,
  type RosterDeviceLists,
  type RosterEntry,
  type RosterMember,
  type SignedRosterEntry
} from './roster';
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

interface Fixture {
  owner: TestUser;
  editor: TestUser;
  viewer: TestUser;
  users: TestUser[];
  lists: RosterDeviceLists;
}

async function fixture(): Promise<Fixture> {
  const owner = await TestUser.create('owner-1');
  const editor = await TestUser.create('editor-1');
  const viewer = await TestUser.create('viewer-1');
  const users = [owner, editor, viewer];
  return {
    owner,
    editor,
    viewer,
    users,
    lists: (userId, identityKeyHash) =>
      users.find(
        (u) =>
          u.userId === userId &&
          equalBytes(u.list.identityKeyHash, identityKeyHash)
      )?.list
  };
}

const memberOf = (
  user: TestUser,
  role: RosterMember['role']
): RosterMember => ({
  userId: user.userId,
  identityKeyHash: user.list.identityKeyHash,
  role
});

async function wrapsFor(users: TestUser[], keyEpoch: number) {
  return Promise.all(
    users.map(async (user) => ({
      userId: user.userId,
      sealedKey: await sealKey(user.encryptionKey, patternBytes(32, keyEpoch), {
        purpose: 'project-key',
        userId: user.userId,
        projectId: 'project-a',
        keyEpoch
      })
    }))
  );
}

/** The next entry's link fields, keeping the previous epoch by default. */
async function after(previous: SignedRosterEntry, keyEpoch?: number) {
  const prev = decodeRosterEntry(previous.entry);
  return {
    projectId: prev.projectId,
    sequence: prev.sequence + 1,
    keyEpoch: keyEpoch ?? prev.keyEpoch,
    previousEntryHash: await rosterEntryHash(previous.entry)
  };
}

/** Owner creates the project, adds the editor, then the editor rotates. */
async function history(f: Fixture): Promise<SignedRosterEntry[]> {
  const s0 = await signRosterEntry(f.owner.signer(), {
    type: 'membership',
    projectId: 'project-a',
    sequence: 0,
    keyEpoch: 1,
    previousEntryHash: null,
    members: [memberOf(f.owner, 'owner')],
    keyWraps: await wrapsFor([f.owner], 1)
  });
  const s1 = await signRosterEntry(f.owner.signer(), {
    type: 'membership',
    ...(await after(s0)),
    members: [memberOf(f.owner, 'owner'), memberOf(f.editor, 'editor')],
    keyWraps: []
  });
  const s2 = await signRosterEntry(f.editor.signer(), {
    type: 'epoch',
    ...(await after(s1, 2)),
    keyWraps: await wrapsFor([f.owner, f.editor], 2)
  });
  return [s0, s1, s2];
}

/** History plus the owner adding the viewer. */
async function withViewer(f: Fixture): Promise<SignedRosterEntry[]> {
  const chain = await history(f);
  chain.push(
    await signRosterEntry(f.owner.signer(), {
      type: 'membership',
      ...(await after(chain[2]!)),
      members: [
        memberOf(f.owner, 'owner'),
        memberOf(f.editor, 'editor'),
        memberOf(f.viewer, 'viewer')
      ],
      keyWraps: []
    })
  );
  return chain;
}

describe('roster entry encoding', () => {
  it('round-trips every type canonically', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const extra: RosterEntry[] = [
      {
        type: 'self-removal',
        ...(await after(chain[3]!)),
        removedUserId: 'viewer-1'
      },
      {
        type: 'anchor-transfer',
        ...(await after(chain[3]!)),
        newIdentityKeyHash: patternBytes(32, 0x55)
      }
    ];
    for (const entry of [
      ...chain.map((signed) => decodeRosterEntry(signed.entry)),
      ...extra
    ]) {
      const bytes = encodeRosterEntry(entry);
      const decoded = decodeRosterEntry(bytes);
      expect(decoded.type).toBe(entry.type);
      expect(encodeRosterEntry(decoded)).toEqual(bytes);
      if (entry.type === 'membership') {
        expect(
          encodeRosterEntry({ ...entry, members: [...entry.members].reverse() })
        ).toEqual(bytes);
      }
    }
    const future = new Uint8Array(chain[0]!.entry);
    future[3] = 2;
    expect(() => decodeRosterEntry(future)).toThrow(
      expect.objectContaining({ code: 'unsupported-version' })
    );
    const unknownType = new Uint8Array(chain[0]!.entry);
    unknownType[4] = 9;
    expect(() => decodeRosterEntry(unknownType)).toThrow(E2eeError);
  });

  it('rejects invalid shapes', async () => {
    const f = await fixture();
    const chain = await history(f);
    const first = decodeRosterEntry(chain[0]!.entry);
    const epoch = decodeRosterEntry(chain[2]!.entry);
    if (first.type !== 'membership' || epoch.type !== 'epoch')
      throw new Error();
    const link = await after(chain[2]!, 3);
    for (const bad of [
      { ...first, keyWraps: [] },
      { ...epoch, sequence: 0, previousEntryHash: null },
      {
        ...first,
        members: [memberOf(f.owner, 'owner'), memberOf(f.editor, 'owner')]
      },
      {
        ...first,
        members: [memberOf(f.editor, 'editor')],
        keyWraps: await wrapsFor([f.editor], 1)
      },
      { ...first, members: [] },
      { ...epoch, keyWraps: [] },
      {
        ...epoch,
        keyWraps: [...epoch.keyWraps, { ...epoch.keyWraps[0]! }]
      },
      {
        type: 'self-removal' as const,
        ...link,
        removedUserId: 'has space'
      },
      {
        type: 'anchor-transfer' as const,
        ...link,
        newIdentityKeyHash: patternBytes(31)
      },
      { ...epoch, type: 'promote' as never }
    ]) {
      await rejectsWith(
        signRosterEntry(f.owner.signer(), bad),
        'invalid-argument'
      );
    }
  });
});

describe('roster chains', () => {
  it('fold typed entries into the roster in force', async () => {
    const f = await fixture();
    const verified = await verifyRosterChain(await history(f), f.lists);
    expect(
      verified.map((v) => [
        v.entry.type,
        v.signer.userId,
        v.signer.signedBy,
        v.state.keyEpoch,
        v.state.members.map((m) => m.userId).sort()
      ])
    ).toEqual([
      ['membership', 'owner-1', 'device', 1, ['owner-1']],
      ['membership', 'owner-1', 'device', 1, ['editor-1', 'owner-1']],
      ['epoch', 'editor-1', 'device', 2, ['editor-1', 'owner-1']]
    ]);
    expect(verified[2]!.state.anchor).toEqual({
      userId: 'owner-1',
      identityKeyHash: f.owner.list.identityKeyHash
    });
  });

  it('continue from a verified state or a pin, and refuse rollback', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const verified = await verifyRosterChain(chain, f.lists);
    const tail = await verifyRosterChain(chain.slice(2), f.lists, {
      from: verified[1]!.state
    });
    expect(tail.at(-1)!.state).toEqual(verified.at(-1)!.state);
    await rejectsWith(
      verifyRosterChain(chain.slice(2), f.lists),
      'chain-broken'
    );
    await rejectsWith(
      verifyRosterChain(chain.slice(0, 2), f.lists, {
        pinnedEntryHash: verified[3]!.hash
      }),
      'chain-broken'
    );
    await rejectsWith(
      verifyRosterChain([chain[0]!, chain[2]!], f.lists),
      'chain-broken'
    );
    await rejectsWith(verifyRosterChain([], f.lists), 'chain-broken');
    const tampered = new Uint8Array(chain[1]!.entry);
    tampered[tampered.byteLength - 3]! ^= 1;
    await expect(
      verifyRosterChain([chain[0]!, { ...chain[1]!, entry: tampered }], f.lists)
    ).rejects.toBeInstanceOf(E2eeError);
  });

  it('enforce the membership signer: the owner device only', async () => {
    const f = await fixture();
    const chain = await history(f);
    const addViewer = {
      type: 'membership' as const,
      ...(await after(chain[2]!)),
      members: [
        memberOf(f.owner, 'owner'),
        memberOf(f.editor, 'editor'),
        memberOf(f.viewer, 'viewer')
      ],
      keyWraps: []
    };
    await verifyRosterChain(
      [...chain, await signRosterEntry(f.owner.signer(), addViewer)],
      f.lists
    );
    for (const signed of [
      await signRosterEntry(f.editor.signer(), addViewer),
      await signRosterEntryWithIdentity(f.owner.identity.privateKey, addViewer)
    ]) {
      await rejectsWith(
        verifyRosterChain([...chain, signed], f.lists),
        'authentication-failed'
      );
    }
    // A device list for another identity than the roster's anchor.
    const impostor = await TestUser.create('owner-1');
    await rejectsWith(
      verifyRosterChain(chain, (userId, hash) =>
        userId === 'owner-1' ? impostor.list : f.lists(userId, hash)
      ),
      'authentication-failed'
    );
  });

  it('enforce membership limits: keep the anchor; rotate now or later on removal', async () => {
    const f = await fixture();
    const chain = await history(f);
    // Handing ownership to someone else.
    const handOver = await signRosterEntry(f.owner.signer(), {
      type: 'membership',
      ...(await after(chain[2]!)),
      members: [memberOf(f.owner, 'editor'), memberOf(f.editor, 'owner')],
      keyWraps: []
    });
    await rejectsWith(
      verifyRosterChain([...chain, handOver], f.lists),
      'chain-broken'
    );
    // The owner removes the editor and rotates in the same entry.
    const removeAndRotate = await signRosterEntry(f.owner.signer(), {
      type: 'membership',
      ...(await after(chain[2]!, 3)),
      members: [memberOf(f.owner, 'owner')],
      keyWraps: await wrapsFor([f.owner], 3)
    });
    const rotated = (
      await verifyRosterChain([...chain, removeAndRotate], f.lists)
    ).at(-1)!.state;
    expect(rotated).toMatchObject({ keyEpoch: 3, rotationPending: false });
    checkVersionEpoch(rotated, 3);
    // Or removes without rotating: versions wait for a new epoch.
    const removeOnly = await signRosterEntry(f.owner.signer(), {
      type: 'membership',
      ...(await after(chain[2]!)),
      members: [memberOf(f.owner, 'owner')],
      keyWraps: []
    });
    const pending = (
      await verifyRosterChain([...chain, removeOnly], f.lists)
    ).at(-1)!.state;
    expect(pending).toMatchObject({ keyEpoch: 2, rotationPending: true });
    expect(() => checkVersionEpoch(pending, 2)).toThrow(
      expect.objectContaining({ code: 'context-mismatch' })
    );
    // Adding someone does not clear it; only a new epoch does.
    const addViewer = await signRosterEntry(f.owner.signer(), {
      type: 'membership',
      ...(await after(removeOnly)),
      members: [memberOf(f.owner, 'owner'), memberOf(f.viewer, 'viewer')],
      keyWraps: []
    });
    const rotate = await signRosterEntry(f.viewer.signer(), {
      type: 'epoch',
      ...(await after(addViewer, 3)),
      keyWraps: await wrapsFor([f.owner, f.viewer], 3)
    });
    const states = (
      await verifyRosterChain(
        [...chain, removeOnly, addViewer, rotate],
        f.lists
      )
    ).map((v) => v.state);
    expect(states[4]!.rotationPending).toBe(true);
    expect(states[5]).toMatchObject({ keyEpoch: 3, rotationPending: false });
    checkVersionEpoch(states[5]!, 3);
    expect(() => checkVersionEpoch(states[5]!, 2)).toThrow(E2eeError);
  });

  it('let any member, viewers included, start an epoch that changes nothing else', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const rotate = {
      type: 'epoch' as const,
      ...(await after(chain[3]!, 3)),
      keyWraps: await wrapsFor([f.owner, f.editor, f.viewer], 3)
    };
    await verifyRosterChain(
      [...chain, await signRosterEntry(f.viewer.signer(), rotate)],
      f.lists
    );
    const outsider = await TestUser.create('outsider');
    f.users.push(outsider);
    await rejectsWith(
      verifyRosterChain(
        [
          ...chain,
          await signRosterEntry(
            { ...outsider.signer(), userId: 'outsider' },
            rotate
          )
        ],
        f.lists
      ),
      'authentication-failed'
    );
    // Wrapping to a subset would drop a member: refused.
    const partial = await signRosterEntry(f.viewer.signer(), {
      ...rotate,
      keyWraps: await wrapsFor([f.owner, f.viewer], 3)
    });
    await rejectsWith(
      verifyRosterChain([...chain, partial], f.lists),
      'chain-broken'
    );
    const sameEpoch = await signRosterEntry(f.viewer.signer(), {
      ...rotate,
      keyEpoch: 2
    });
    await rejectsWith(
      verifyRosterChain([...chain, sameEpoch], f.lists),
      'chain-broken'
    );
  });
});

describe('roster read modes', () => {
  it('current head advances the pin; historical reads use the named entry', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const first = await acceptCurrentRoster(chain.slice(0, 2), f.lists);
    expect(first.pin.advanced).toBe(true);
    const next = await acceptCurrentRoster(chain, f.lists, {
      pinnedEntryHash: first.pin.pin
    });
    expect(next.pin.pin).toEqual(next.entries[3]!.hash);
    // Older roster offered as current: refused.
    await rejectsWith(
      acceptCurrentRoster(chain.slice(0, 2), f.lists, {
        pinnedEntryHash: next.pin.pin
      }),
      'chain-broken'
    );
    // A historical version names entry 1 (before the viewer joined).
    const old = historicalRosterState(
      next.entries,
      next.pin.pin,
      next.entries[1]!.hash
    );
    expect(old.members.map((m) => m.userId).sort()).toEqual([
      'editor-1',
      'owner-1'
    ]);
    expect(old.keyEpoch).toBe(1);
    // An entry newer than the pin, or not in the chain, is refused.
    expect(() =>
      historicalRosterState(
        next.entries,
        next.entries[1]!.hash,
        next.entries[3]!.hash
      )
    ).toThrow(expect.objectContaining({ code: 'chain-broken' }));
    expect(() =>
      historicalRosterState(next.entries, next.pin.pin, patternBytes(32))
    ).toThrow(expect.objectContaining({ code: 'chain-broken' }));
  });
});

describe('self-removal', () => {
  async function removal(chain: SignedRosterEntry[], userId: string) {
    return {
      type: 'self-removal' as const,
      ...(await after(chain.at(-1)!)),
      removedUserId: userId
    };
  }

  it('is signed by the departing member, by device or identity key', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const byDevice = await signRosterEntry(
      f.viewer.signer(),
      await removal(chain, 'viewer-1')
    );
    const verified = await verifyRosterChain([...chain, byDevice], f.lists);
    expect(verified.at(-1)!.state).toMatchObject({
      keyEpoch: 2,
      rotationPending: true
    });
    expect(
      verified
        .at(-1)!
        .state.members.map((m) => m.userId)
        .sort()
    ).toEqual(['editor-1', 'owner-1']);
    // An exposed identity's last act: removing itself.
    const byIdentity = await signRosterEntryWithIdentity(
      f.editor.identity.privateKey,
      await removal(chain, 'editor-1')
    );
    const viaIdentity = await verifyRosterChain(
      [...chain, byIdentity],
      f.lists
    );
    expect(viaIdentity.at(-1)!.signer).toMatchObject({
      userId: 'editor-1',
      signedBy: 'identity',
      device: null
    });
  });

  it('carries no key; the next epoch comes from a remaining member', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const leave = await signRosterEntry(
      f.viewer.signer(),
      await removal(chain, 'viewer-1')
    );
    const state = (await verifyRosterChain([...chain, leave], f.lists)).at(
      -1
    )!.state;
    // Versions after the removal are refused until the rotation.
    expect(() => checkVersionEpoch(state, 2)).toThrow(
      expect.objectContaining({ code: 'context-mismatch' })
    );
    // A self-removal that tries to start an epoch is refused.
    const withEpoch = await signRosterEntry(f.viewer.signer(), {
      ...(await removal(chain, 'viewer-1')),
      keyEpoch: 3
    });
    await rejectsWith(
      verifyRosterChain([...chain, withEpoch], f.lists),
      'chain-broken'
    );
    const rotation = {
      type: 'epoch' as const,
      ...(await after(leave, 3)),
      keyWraps: await wrapsFor([f.owner, f.editor], 3)
    };
    // The departed member's device cannot start it…
    await rejectsWith(
      verifyRosterChain(
        [...chain, leave, await signRosterEntry(f.viewer.signer(), rotation)],
        f.lists
      ),
      'authentication-failed'
    );
    // …a remaining member's can, and versions resume under the new epoch.
    const done = (
      await verifyRosterChain(
        [...chain, leave, await signRosterEntry(f.editor.signer(), rotation)],
        f.lists
      )
    ).at(-1)!.state;
    checkVersionEpoch(done, 3);
    // Wrapping the new key to the departed member is refused.
    const leaky = await signRosterEntry(f.editor.signer(), {
      ...rotation,
      keyWraps: await wrapsFor([f.owner, f.editor, f.viewer], 3)
    });
    await rejectsWith(
      verifyRosterChain([...chain, leave, leaky], f.lists),
      'chain-broken'
    );
  });

  it('cannot remove anyone else', async () => {
    const f = await fixture();
    const chain = await withViewer(f);
    const entry = await removal(chain, 'viewer-1');
    for (const signed of [
      await signRosterEntry(f.owner.signer(), entry),
      await signRosterEntryWithIdentity(f.owner.identity.privateKey, entry)
    ]) {
      await expect(
        verifyRosterChain([...chain, signed], f.lists)
      ).rejects.toBeInstanceOf(E2eeError);
    }
  });
});

describe('anchor transfer', () => {
  it('is signed by the old owner identity and moves the anchor', async () => {
    const f = await fixture();
    const chain = await history(f);
    const newOwner = await TestUser.create('owner-1');
    f.users.push(newOwner);
    const transfer = await signRosterEntryWithIdentity(
      f.owner.identity.privateKey,
      {
        type: 'anchor-transfer',
        ...(await after(chain[2]!)),
        newIdentityKeyHash: newOwner.list.identityKeyHash
      }
    );
    const verified = await verifyRosterChain([...chain, transfer], f.lists);
    const state = verified.at(-1)!.state;
    expect(state.anchor.identityKeyHash).toEqual(newOwner.list.identityKeyHash);
    expect(state.members.find((m) => m.userId === 'owner-1')).toMatchObject({
      role: 'owner',
      identityKeyHash: newOwner.list.identityKeyHash
    });
    // Phase 5 refuses the new anchor until members verified it.
    await rejectsWith(
      verifyRosterChain([...chain, transfer], f.lists, {
        authorize: (entry) => entry.type !== 'anchor-transfer'
      }),
      'authentication-failed'
    );
    // From then on the new identity's devices sign membership entries…
    const next = {
      type: 'membership' as const,
      ...(await after(transfer)),
      members: [...state.members, memberOf(f.viewer, 'viewer')],
      keyWraps: []
    };
    await verifyRosterChain(
      [...chain, transfer, await signRosterEntry(newOwner.signer(), next)],
      f.lists
    );
    // …and the old identity's devices no longer can.
    await rejectsWith(
      verifyRosterChain(
        [...chain, transfer, await signRosterEntry(f.owner.signer(), next)],
        f.lists
      ),
      'authentication-failed'
    );
  });

  it('follows the old identity’s self-removal', async () => {
    const f = await fixture();
    const chain = await history(f);
    const newOwner = await TestUser.create('owner-1');
    f.users.push(newOwner);
    const leave = await signRosterEntryWithIdentity(
      f.owner.identity.privateKey,
      {
        type: 'self-removal',
        ...(await after(chain[2]!)),
        removedUserId: 'owner-1'
      }
    );
    const transfer = await signRosterEntryWithIdentity(
      f.owner.identity.privateKey,
      {
        type: 'anchor-transfer',
        ...(await after(leave)),
        newIdentityKeyHash: newOwner.list.identityKeyHash
      }
    );
    const verified = await verifyRosterChain(
      [...chain, leave, transfer],
      f.lists
    );
    expect(verified[3]!.state.members.map((m) => m.userId)).toEqual([
      'editor-1'
    ]);
    expect(verified[4]!.state.members.map((m) => m.userId).sort()).toEqual([
      'editor-1',
      'owner-1'
    ]);
  });

  it('refuses device keys, the new identity, other members and a new epoch', async () => {
    const f = await fixture();
    const chain = await history(f);
    const newOwner = await TestUser.create('owner-1');
    f.users.push(newOwner);
    const entry = {
      type: 'anchor-transfer' as const,
      ...(await after(chain[2]!)),
      newIdentityKeyHash: newOwner.list.identityKeyHash
    };
    for (const signed of [
      await signRosterEntry(f.owner.signer(), entry),
      await signRosterEntryWithIdentity(newOwner.identity.privateKey, entry),
      await signRosterEntryWithIdentity(f.editor.identity.privateKey, entry)
    ]) {
      await rejectsWith(
        verifyRosterChain([...chain, signed], f.lists),
        'authentication-failed'
      );
    }
    const withEpoch = await signRosterEntryWithIdentity(
      f.owner.identity.privateKey,
      { ...entry, keyEpoch: 3 }
    );
    await rejectsWith(
      verifyRosterChain([...chain, withEpoch], f.lists),
      'chain-broken'
    );
  });
});

describe('revoked roster signers', () => {
  it('count only within the roster cutoff', async () => {
    const f = await fixture();
    const chain = await history(f);
    const hashes = (await verifyRosterChain(chain, f.lists)).map((v) => v.hash);
    await f.editor.addDevice('spare');
    await f.editor.revoke('d1', [
      {
        projectId: 'project-a',
        versionHead: patternBytes(32),
        rosterHead: hashes[2]!
      }
    ]);
    await verifyRosterChain(chain, f.lists);

    const strict = await fixture();
    const strictChain = await history(strict);
    const strictHashes = (
      await verifyRosterChain(strictChain, strict.lists)
    ).map((v) => v.hash);
    await strict.editor.addDevice('spare');
    await strict.editor.revoke('d1', [
      {
        projectId: 'project-a',
        versionHead: patternBytes(32),
        rosterHead: strictHashes[1]!
      }
    ]);
    await rejectsWith(
      verifyRosterChain(strictChain, strict.lists),
      'key-revoked'
    );
  });
});
