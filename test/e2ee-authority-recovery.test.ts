import { expect, it } from 'vitest';
import {
  fromHex,
  generateSigningKeyPair,
  signGroupReset,
  signRevocationCutoffs,
  verifyRevocationCutoffs
} from '@openzcad/crypto';
import {
  GROUP_RESET_CONFIRMATION,
  resetProjectGroup,
  epochAuthority
} from '../apps/web/src/lib/e2ee/projectGroups';
import { loadProjectAuthority } from '../apps/web/src/lib/e2ee/projectAuthority';
import {
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  OWNER
} from './support/e2ee-documents';
import { head } from './support/e2ee-members';

it('recovers a solo group on a cold replacement after its sole writer and authority signer was revoked', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  const srv = newServer([owner]);
  const old = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(old);
  const projectId = document.projectId;
  const named = await old.store.saveRevision({
    projectId,
    expectedVersion: document.version,
    document,
    reason: 'Before recovery'
  });
  const revisionId = named.revisions.at(-1)!.revisionId;
  const accepted = head(srv, projectId);
  await owner.revoke(srv.db, 'owner_laptop');
  const entry = owner.list.entries.at(-1)!;
  const cutoffs = await verifyRevocationCutoffs(
    await signRevocationCutoffs(owner.identityPrivateKey, {
      userId: OWNER,
      generation: 1,
      entrySequence: entry.entry.sequence,
      entryHash: entry.hash,
      issuedAt: Date.now(),
      cutoffs: [
        {
          projectId,
          cutoffEpoch: 1,
          head: {
            documentVersion: accepted.document_version,
            versionHash: fromHex(accepted.version_hash)
          }
        }
      ]
    }),
    owner.list,
    { generation: 1 }
  );
  const replacement = device(srv, owner, 'owner_desktop', {
    revocations: { verified: async () => [cutoffs] }
  });
  expect(replacement.sessions.cachedSessions).toBe(0);
  expect(
    (await replacement.groups.authorityStore!.read(OWNER, projectId)).owner
  ).toBeNull();
  await expect(
    loadProjectAuthority(replacement.groups, projectId)
  ).rejects.toThrow(/currently certified/);
  const wrong = await generateSigningKeyPair();
  await expect(
    resetProjectGroup(
      replacement.groups,
      projectId,
      {
        generation: 1,
        sign: (value) => signGroupReset(wrong.privateKey, value)
      },
      GROUP_RESET_CONFIRMATION
    )
  ).rejects.toThrow(/identity key/);
  expect(
    (await replacement.groups.authorityStore!.read(OWNER, projectId)).accepted
  ).toBeNull();
  expect(
    (await replacement.groups.api.group(projectId)).group?.generation
  ).toBe(0);

  expect(
    await resetProjectGroup(
      replacement.groups,
      projectId,
      {
        generation: 1,
        sign: (value) => signGroupReset(owner.identityPrivateKey, value)
      },
      GROUP_RESET_CONFIRMATION
    )
  ).toEqual({ epoch: 0, keyEpoch: 1 });
  const restored = await loadProjectAuthority(replacement.groups, projectId);
  expect(restored?.manifest.roots).toHaveLength(2);
  expect(restored?.manifest.roots[1]?.resetAuthority).toBeDefined();
  expect(
    (await epochAuthority(replacement.groups, projectId, 0)).members.map(
      (member) => member.deviceId
    )
  ).toEqual(['owner_laptop']);
  const previous = await replacement.store.loadProject(projectId);
  expect(previous.name).toBe(document.name);
  await replacement.store.saveProjectDocument({
    projectId,
    expectedVersion: previous.version,
    document: edited(previous, 'Recovered and encrypted')
  });
  const fresh = device(srv, owner, null, {
    revocations: { verified: async () => [cutoffs] }
  });
  expect((await fresh.store.loadProject(projectId)).name).toBe(
    'Recovered and encrypted'
  );
  expect((await fresh.store.loadRevision(projectId, revisionId))?.name).toBe(
    document.name
  );
  expect(fresh.sessions.cachedSessions).toBe(0);
}, 30_000);
