import { beforeAll, describe, expect, it } from 'vitest';
import {
  signMlsAuthorityManifest,
  signMlsAuthorityTrust,
  toBase64Url,
  toHex
} from '@openzcad/crypto';
import {
  createEncrypted,
  device,
  makeAccount,
  newServer,
  OWNER,
  OTHER,
  type Account
} from './support/e2ee-documents';
import type { E2eeSaveProjectAuthorityRequest } from '@openzcad/shared';
import { sqliteD1 } from './support/sqlite-d1';

let owner: Account;
let other: Account;
beforeAll(async () => {
  owner = await makeAccount(
    OWNER,
    ['owner_laptop', 'owner_desktop'],
    ['read_only']
  );
  other = await makeAccount(OTHER, ['other_laptop']);
});

async function setup() {
  const srv = newServer([owner, other]);
  const laptop = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  // Isolate the storage protocol from the application's creation bootstrap.
  srv.db
    .prepare('DELETE FROM e2ee_project_authority WHERE project_id = ?')
    .run(document.projectId);
  return { srv, laptop, projectId: document.projectId };
}
async function authority(
  projectId: string,
  sequence = 1,
  signer = 'owner_laptop'
): Promise<E2eeSaveProjectAuthorityRequest> {
  const key = owner.devices.get(signer)!.signing.privateKey;
  const manifest = await signMlsAuthorityManifest(key, {
    projectId,
    ownerUserId: OWNER,
    ownerIdentityKeyHash: toHex(owner.list.identityKeyHash),
    roots: [{ generation: 0, keyEpochBase: 0, groupInfo: 'AA' }],
    checkpoint: null,
    signerDeviceId: signer
  });
  const signed = await signMlsAuthorityTrust(owner.accountKey, key, {
    userId: OWNER,
    projectId,
    sequence,
    accountKeyGeneration: 1,
    accountKeySequence: 0,
    signerDeviceId: signer,
    manifest: {
      statement: toBase64Url(manifest.statement),
      signature: toBase64Url(manifest.signature)
    },
    latestKeyEpoch: 0,
    latestGroupInfo: 'AA'
  });
  return {
    sequence,
    expectedSequence: sequence - 1,
    accountKeyGeneration: 1,
    accountKeySequence: 0,
    signerDeviceId: signer,
    record: toBase64Url(signed.record),
    recordMac: toBase64Url(signed.recordMac),
    signature: toBase64Url(signed.signature)
  };
}

describe('account-authenticated project authority storage', () => {
  it('stores only this account record, with compare-and-swap and lost-response retry', async () => {
    const { srv, laptop, projectId } = await setup();
    expect(await laptop.groups.api.authority!(projectId)).toEqual({
      authority: null
    });
    await expect(
      laptop.groups.api.saveAuthority!(projectId, await authority(projectId, 2))
    ).rejects.toMatchObject({ status: 409, code: 'E2EE_AUTHORITY_CONFLICT' });
    const first = await authority(projectId);
    const saved = await laptop.groups.api.saveAuthority!(projectId, first);
    const { expectedSequence: _, ...record } = first;
    expect(saved.authority).toEqual(record);
    expect(await laptop.groups.api.saveAuthority!(projectId, first)).toEqual(
      saved
    );
    const second = await authority(projectId, 2, 'owner_desktop');
    await laptop.groups.api.saveAuthority!(projectId, second);
    await expect(
      laptop.groups.api.saveAuthority!(projectId, first)
    ).rejects.toMatchObject({ status: 409, code: 'E2EE_AUTHORITY_CONFLICT' });
    expect(
      (await laptop.groups.api.authority!(projectId)).authority?.sequence
    ).toBe(2);
    expect(
      (
        await srv.call('GET', `/api/e2ee/projects/${projectId}/authority`, {
          user: OTHER
        })
      ).status
    ).toBe(404);
    const readOnly = device(srv, owner, null);
    expect(
      (await readOnly.groups.api.authority!(projectId)).authority?.sequence
    ).toBe(2);
  });

  it('rejects forged signatures, transplanted metadata and uncertified signers', async () => {
    const { laptop, projectId } = await setup();
    const first = await authority(projectId);
    for (const changed of [
      { ...first, recordMac: 'A'.repeat(43) },
      { ...first, signerDeviceId: 'owner_desktop' },
      { ...first, accountKeyGeneration: 2 },
      { ...first, accountKeySequence: 1 },
      { ...first, sequence: 2 },
      { ...first, signature: 'A'.repeat(87) },
      await authority(projectId, 1, 'read_only')
    ])
      await expect(
        laptop.groups.api.saveAuthority!(projectId, changed)
      ).rejects.toBeInstanceOf(Error);
    expect(
      (await laptop.groups.api.authority!(projectId)).authority
    ).toBeNull();
  });

  it('cascades when staging is discarded and keeps the sequence trigger monotonic', async () => {
    const { srv, laptop, projectId } = await setup();
    await laptop.groups.api.saveAuthority!(
      projectId,
      await authority(projectId)
    );
    expect(() =>
      srv.db
        .prepare(
          'UPDATE e2ee_project_authority SET sequence = 1 WHERE project_id = ?'
        )
        .run(projectId)
    ).toThrow(/E2EE_AUTHORITY_SEQUENCE/);
    srv.db
      .prepare('DELETE FROM e2ee_project_groups WHERE project_id = ?')
      .run(projectId);
    expect(
      srv.db
        .prepare('SELECT 1 FROM e2ee_project_authority WHERE project_id = ?')
        .get(projectId)
    ).toBeUndefined();
  });

  it('reports missing migration without naming absent tables and leaves ordinary group reads available', async () => {
    const { srv, laptop, projectId } = await setup();
    srv.db.exec('DROP TABLE e2ee_project_authority');
    srv.env.DB = sqliteD1(srv.db);
    await expect(laptop.groups.api.authority!(projectId)).rejects.toMatchObject(
      { status: 503, code: 'E2EE_UNAVAILABLE' }
    );
    expect((await laptop.groups.api.group(projectId)).group.epoch).toBe(0);
  });
});
