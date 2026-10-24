// @vitest-environment node
// The committed MLS WASM is read from disk, which needs Node’s file URLs.
import { beforeAll, describe, expect, it } from 'vitest';
import { inProcessMls } from '../../../../../../packages/mls/src/test-support';
import { claimedCertifiedEpoch } from './certify';
import type { DirectoryInput } from './directory';
import { createMlsLoader } from './loader';
import { MlsProjectSessions, type MlsProjectRef } from './projectSessions';
import { memoryMlsSessionStore, type MlsSessionStore } from './sessionStore';
import { device, testAccount, type TestAccount } from './testFixtures';

let alice: TestAccount;
let projects = 0;

beforeAll(async () => {
  alice = await testAccount('user_alice', ['alice_laptop', 'alice_phone']);
});

const tab = (store: MlsSessionStore = memoryMlsSessionStore()) =>
  new MlsProjectSessions(
    store,
    createMlsLoader(async () => inProcessMls())
  );

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function refs() {
  const projectId = `prj_rejoin_${++projects}`;
  const ref = (deviceId: string): MlsProjectRef => ({
    userId: alice.userId,
    deviceId,
    projectId
  });
  return { projectId, laptop: ref('alice_laptop'), phone: ref('alice_phone') };
}

async function directoryOf(
  ...holders: [MlsProjectSessions, MlsProjectRef][]
): Promise<DirectoryInput> {
  const certifications = [];
  for (const [sessions, ref] of holders) {
    const leaf = (await sessions.leaf(ref))!;
    certifications.push({
      userId: ref.userId,
      deviceId: ref.deviceId,
      leafKey: leaf.signatureKey,
      certification: leaf.certification
    });
  }
  return { lists: [alice.list], certifications };
}

describe('MLS project sessions: rejoin and previews', () => {
  it('previews a rejoin without writing, discards it and retries with the same leaf', async () => {
    const { laptop, phone } = refs();
    const owner = tab();
    const created = await owner.createGroup(
      laptop,
      device(alice, 'alice_laptop'),
      { lists: [alice.list], certifications: [] }
    );
    const zero = await owner.epochMaterial(laptop);
    expect(zero.epoch).toBe(0);
    expect(created.epochRecord).not.toBeNull();

    const store = memoryMlsSessionStore();
    const joiner = tab(store);
    const directory = await directoryOf([owner, laptop]);
    const request = {
      archive: { initialGroupInfo: zero.groupInfo, epochRecords: [] },
      psk: zero.rejoinPsk
    };
    const first = await joiner.rejoin(
      phone,
      device(alice, 'alice_phone'),
      directory,
      0,
      zero.groupInfo,
      request
    );
    expect(first.change.epoch).toBe(1);
    const stored = await store.loadSession(phone.userId, phone.projectId);
    expect(hex(stored!.pendingCommit!.commit)).toBe(hex(first.commit));
    const leaf = (await joiner.leaf(phone))!;
    expect(claimedCertifiedEpoch(leaf.certification)).toBe(0);

    const preview = await joiner.previewPending(phone, directory);
    expect(preview).toMatchObject({
      epoch: 1,
      external: true,
      epochRecord: null
    });
    // Nothing was written, and the rejoin is still provisional.
    expect(
      (await store.loadSession(phone.userId, phone.projectId))!.revision
    ).toBe(stored!.revision);
    expect((await joiner.status(phone)).pendingRejoin).toBe(true);

    // Lost the epoch: back to a certified leaf without a group.
    await joiner.discardRejoin(phone);
    expect(await joiner.status(phone)).toMatchObject({
      inGroup: false,
      pendingRejoin: false
    });
    expect(await joiner.pendingCommit(phone)).toBeNull();

    // The retry reuses that leaf, and its exports are the preview's.
    const second = await joiner.rejoin(
      phone,
      device(alice, 'alice_phone'),
      directory,
      0,
      zero.groupInfo,
      request
    );
    expect(hex((await joiner.leaf(phone))!.signatureKey)).toBe(
      hex(leaf.signatureKey)
    );
    const again = await joiner.previewPending(phone, directory);
    await joiner.confirmRejoin(phone, directory);
    const material = await joiner.epochMaterial(phone);
    expect(hex(material.projectKey)).toBe(hex(again.projectKey));
    expect(hex(material.epochAuthenticator)).toBe(
      hex(again.epochAuthenticator)
    );
    expect(material.rejoinPsk.epoch).toBe(1);

    // The owner's device processes the external Commit to the same epoch.
    const withPhone = await directoryOf([owner, laptop], [joiner, phone]);
    const processed = await owner.process(laptop, withPhone, second.commit);
    expect(processed).toMatchObject({ kind: 'commit', change: { epoch: 1 } });
    expect(hex(await owner.projectKey(laptop))).toBe(hex(material.projectKey));
  });

  it('previews a member Commit with the keys its confirmation yields', async () => {
    const { laptop } = refs();
    const owner = tab();
    await owner.createGroup(laptop, device(alice, 'alice_laptop'), {
      lists: [alice.list],
      certifications: []
    });
    const directory = await directoryOf([owner, laptop]);
    await owner.commit(laptop, directory);
    const preview = await owner.previewPending(laptop, directory);
    expect(preview.external).toBe(false);
    expect(preview.epochRecord).not.toBeNull();
    expect((await owner.status(laptop)).epoch).toBe(0);
    const change = await owner.confirmCommit(laptop, directory);
    expect(change.epoch).toBe(preview.epoch);
    expect(hex(change.epochRecord!)).toBe(hex(preview.epochRecord!));
    expect(hex(await owner.projectKey(laptop))).toBe(hex(preview.projectKey));
    await expect(owner.previewPending(laptop, directory)).rejects.toThrow(
      'No Commit is pending'
    );
  });

  it('replaces a leaf this same device left behind when it lost its state', async () => {
    const { laptop, phone } = refs();
    const lost = tab();
    await lost.createGroup(laptop, device(alice, 'alice_laptop'), {
      lists: [alice.list],
      certifications: []
    });
    const zero = await lost.epochMaterial(laptop);
    const phoneTab = tab();
    const phoneJoin = await phoneTab.rejoin(
      phone,
      device(alice, 'alice_phone'),
      await directoryOf([lost, laptop]),
      0,
      zero.groupInfo,
      {
        archive: { initialGroupInfo: zero.groupInfo, epochRecords: [] },
        psk: zero.rejoinPsk
      }
    );
    const both = await directoryOf([lost, laptop], [phoneTab, phone]);
    await phoneTab.confirmRejoin(phone, both);
    const one = await phoneTab.epochMaterial(phone);

    // The laptop's storage is wiped; the same device id rejoins.
    const wiped = tab();
    const result = await wiped.rejoin(
      laptop,
      device(alice, 'alice_laptop'),
      both,
      1,
      one.groupInfo,
      {
        archive: {
          initialGroupInfo: zero.groupInfo,
          epochRecords: [phoneJoin.change.epochRecord!]
        },
        psk: one.rejoinPsk
      }
    );
    expect(result.change.removed).toEqual([
      expect.objectContaining({ deviceId: 'alice_laptop' })
    ]);
    const all = await directoryOf(
      [lost, laptop],
      [phoneTab, phone],
      [wiped, laptop]
    );
    await wiped.confirmRejoin(laptop, all);
    const status = await wiped.status(laptop);
    expect(status.members.map((m) => m.deviceId).sort()).toEqual([
      'alice_laptop',
      'alice_phone'
    ]);
    await phoneTab.process(phone, all, result.commit);
    expect(hex(await phoneTab.projectKey(phone))).toBe(
      hex(await wiped.projectKey(laptop))
    );
  });
});
