import { afterEach, expect, it } from 'vitest';
import {
  decodeMlsAuthorityManifest,
  fromBase64Url,
  signRevocationCutoffs,
  verifyRevocationCutoffs,
  type SignedStatement,
  type RevocationCutoffs
} from '@openzcad/crypto';
import {
  authorityManifestForState,
  commitProjectGroup
} from '../apps/web/src/lib/e2ee/projectGroups';
import { parseGroupInfoContext } from '../apps/web/src/lib/e2ee/mls/epochRoles';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  createEncrypted,
  device,
  makeAccount,
  newServer,
  OWNER,
  type Device
} from './support/e2ee-documents';

afterEach(() => forgetAllProjectKeys());

async function manifest(d: Device, projectId: string) {
  const saved = await d.groups.authorityStore!.read(OWNER, projectId);
  expect(saved.manifest).not.toBeNull();
  return decodeMlsAuthorityManifest(fromBase64Url(saved.manifest!.statement));
}

it('produces a usable owner checkpoint at 256 epochs and retains it before the next interval', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  const srv = newServer([owner]);
  const laptop = device(srv, owner, 'owner_laptop');
  const {
    document: { projectId }
  } = await createEncrypted(laptop);
  expect((await manifest(laptop, projectId)).checkpoint).toBeNull();
  const saved = (await laptop.groups.authorityStore!.read(OWNER, projectId))
    .manifest!;
  let prior: SignedStatement = {
    statement: fromBase64Url(saved.statement),
    signature: fromBase64Url(saved.signature)
  };
  const ref = { userId: OWNER, deviceId: 'owner_laptop', projectId };
  const { leaves } = await laptop.groups.api.leaves(projectId);
  const directory = {
    lists: [owner.list],
    certifications: leaves.map((leaf) => ({
      userId: leaf.userId,
      deviceId: leaf.deviceId,
      leafKey: fromBase64Url(leaf.leafKey),
      certification: fromBase64Url(leaf.certification)
    }))
  };
  let checkpoint: ReturnType<typeof decodeMlsAuthorityManifest>['checkpoint'] =
    null;
  let target: Uint8Array | null = null;
  // Advance the real native session. Exercise the production manifest
  // producer at the boundary without replaying the complete HTTP archive
  // and every earlier historical proof on each of the 257 iterations.
  for (let epoch = 1; epoch <= 257; epoch++) {
    await laptop.sessions.commit(ref, directory, {});
    const changed = await laptop.sessions.confirmCommit(ref, directory);
    expect(changed.epoch).toBe(epoch);
    if (epoch < 255) continue;
    const material = await laptop.sessions.epochMaterial(ref);
    prior = await authorityManifestForState(
      laptop.groups,
      projectId,
      epoch,
      material.groupInfo,
      prior
    );
    const produced = decodeMlsAuthorityManifest(prior.statement);
    if (epoch === 255) expect(produced.checkpoint).toBeNull();
    if (epoch === 256) {
      checkpoint = produced.checkpoint;
      expect(checkpoint).toMatchObject({ generation: 0, keyEpoch: 256 });
      expect(
        parseGroupInfoContext(fromBase64Url(checkpoint!.groupInfo)).epoch
      ).toBe(256);
    }
    if (epoch === 257) {
      expect(produced.checkpoint).toEqual(checkpoint);
      target = changed.epochRecord;
    }
  }
  const verified = await laptop.sessions.verifyEpochAuthority({
    projectId,
    anchor: fromBase64Url(checkpoint!.groupInfo),
    records: [target!],
    targetRecord: target!,
    ownerUserId: OWNER,
    directory
  });
  expect(verified.epoch).toBe(257);
}, 30_000);

it('refreshes a checkpoint on the next owner Commit after an owner device is revoked', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  const srv = newServer([owner]);
  const cutoffs: RevocationCutoffs[] = [];
  const laptop = device(srv, owner, 'owner_laptop', {
    revocations: { verified: async () => cutoffs }
  });
  const {
    document: { projectId }
  } = await createEncrypted(laptop);
  expect((await manifest(laptop, projectId)).checkpoint).toBeNull();
  await owner.revoke(srv.db, 'owner_desktop');
  const entry = owner.list.entries.at(-1)!;
  cutoffs.push(
    await verifyRevocationCutoffs(
      await signRevocationCutoffs(owner.identityPrivateKey, {
        userId: OWNER,
        generation: 1,
        entrySequence: entry.entry.sequence,
        entryHash: entry.hash,
        issuedAt: Date.now(),
        cutoffs: [{ projectId, cutoffEpoch: 1 }]
      }),
      owner.list,
      { generation: 1 }
    )
  );
  await commitProjectGroup(laptop.groups, projectId);
  const produced = await manifest(laptop, projectId);
  expect(produced.signerDeviceId).toBe('owner_laptop');
  expect(produced.checkpoint).toMatchObject({ generation: 0, keyEpoch: 1 });
  expect(
    parseGroupInfoContext(fromBase64Url(produced.checkpoint!.groupInfo)).epoch
  ).toBe(1);
});
