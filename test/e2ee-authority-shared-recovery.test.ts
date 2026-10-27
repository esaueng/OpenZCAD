import { expect, it } from 'vitest';
import {
  signRevocationCutoffs,
  verifyRevocationCutoffs,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import {
  catchUpProjectGroup,
  commitProjectGroup,
  joinProjectGroup,
  postOwnEpochKeys
} from '../apps/web/src/lib/e2ee/projectGroups';
import {
  loadProjectAuthority,
  rememberExpectedProjectOwner
} from '../apps/web/src/lib/e2ee/projectAuthority';
import { device, makeAccount, OWNER, OTHER } from './support/e2ee-documents';
import {
  sharedProject,
  ownerRef,
  serverKeyEpoch
} from './support/e2ee-members';

it('rejoins a cold certified shared replacement from independent owner intent and replaces its retired signer record', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop']);
  const other = await makeAccount(OTHER, ['other_laptop', 'other_replacement']);
  const { srv, laptop, member, projectId, document } = await sharedProject(
    [owner, other],
    owner,
    other,
    'editor'
  );
  await catchUpProjectGroup(laptop.groups, projectId);
  const retired = (await member.groups.api.authority!(projectId)).authority!;
  expect(retired.signerDeviceId).toBe('other_laptop');
  const cutoffEpoch = serverKeyEpoch(srv, projectId) + 1;
  await other.revoke(srv.db, 'other_laptop');
  const entry = other.list.entries.at(-1)!;
  const signed = await signRevocationCutoffs(other.identityPrivateKey, {
    userId: OTHER,
    generation: 1,
    entrySequence: entry.entry.sequence,
    entryHash: entry.hash,
    issuedAt: Date.now(),
    cutoffs: [{ projectId, cutoffEpoch }]
  });
  const cutoffs = await verifyRevocationCutoffs(signed, other.list, {
    generation: 1
  });
  srv.db
    .prepare(
      `INSERT INTO e2ee_revocation_cutoffs
    (user_id, generation, entry_sequence, entry_hash, statement, signature, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, ?, 'now', 'now')`
    )
    .run(
      OTHER,
      entry.entry.sequence,
      toHex(entry.hash),
      toBase64Url(signed.statement),
      toBase64Url(signed.signature)
    );
  const removed = (
    await laptop.sessions.status(ownerRef(projectId))
  ).members.find((leaf) => leaf.deviceId === 'other_laptop')!;
  await commitProjectGroup(laptop.groups, projectId, {
    remove: [removed.index]
  });
  const replacement = device(srv, other, 'other_replacement', {
    members: [owner],
    revocations: { verified: async () => [cutoffs] }
  });
  // Hand the recovered current keys through the real account-wrap route,
  // standing in for a co-member's verified recovery handoff.
  await postOwnEpochKeys(
    replacement.groups,
    projectId,
    serverKeyEpoch(srv, projectId),
    await laptop.sessions.epochMaterial(ownerRef(projectId))
  );
  expect(
    (await replacement.groups.authorityStore!.read(OTHER, projectId)).manifest
  ).toBeNull();
  await expect(
    loadProjectAuthority(replacement.groups, projectId)
  ).rejects.toMatchObject({ code: 'signer-untrusted' });
  await expect(joinProjectGroup(replacement.groups, projectId)).rejects.toThrow(
    /currently certified/
  );
  expect(replacement.sessions.cachedSessions).toBe(0);
  // The verified invitation/owner comparison is independent of the retired
  // account record. A wrong expected owner still cannot bootstrap its roots.
  const wrong = device(srv, other, 'other_replacement', {
    members: [owner],
    revocations: { verified: async () => [cutoffs] }
  });
  await rememberExpectedProjectOwner(wrong.groups, projectId, other.list);
  await expect(joinProjectGroup(wrong.groups, projectId)).rejects.toThrow();
  expect((await member.groups.api.authority!(projectId)).authority).toEqual(
    retired
  );
  await rememberExpectedProjectOwner(replacement.groups, projectId, owner.list);
  await joinProjectGroup(replacement.groups, projectId);
  const repaired = await loadProjectAuthority(replacement.groups, projectId);
  expect(repaired?.record.signerDeviceId).toBe('other_replacement');
  expect(repaired!.record.sequence).toBeGreaterThan(retired.sequence);
  expect((await replacement.store.loadProject(projectId)).name).toBe(
    document.name
  );
  const reader = device(srv, other, null, {
    members: [owner],
    revocations: { verified: async () => [cutoffs] }
  });
  expect((await reader.store.loadProject(projectId)).name).toBe(document.name);
  expect(reader.sessions.cachedSessions).toBe(0);
}, 30_000);
