import { beforeAll, expect, it } from 'vitest';
import {
  decodeMlsAuthorityTrust,
  fromBase64Url,
  signMlsAuthorityTrust,
  toBase64Url,
  type MlsAuthorityTrust
} from '@openzcad/crypto';
import type { E2eeProjectAuthorityRecord } from '@openzcad/shared';
import { loadProjectAuthority } from '../apps/web/src/lib/e2ee/projectAuthority';
import { commitProjectGroup, epochAuthority } from '../apps/web/src/lib/e2ee/projectGroups';
import { confirmKeySessionEnded } from '../apps/web/src/lib/e2ee/keySession';
import { createEncrypted, device, makeAccount, newServer, OWNER, type Account } from './support/e2ee-documents';

let account: Account;
beforeAll(async () => { account = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']); });

async function setup() {
  const srv = newServer([account]);
  const laptop = device(srv, account, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const record = (await laptop.groups.api.authority!(projectId)).authority!;
  return { srv, laptop, projectId, record };
}

async function reseal(record: E2eeProjectAuthorityRecord, changes: Partial<MlsAuthorityTrust>): Promise<E2eeProjectAuthorityRecord> {
  const value = { ...decodeMlsAuthorityTrust(fromBase64Url(record.record)), ...changes };
  const sealed = await signMlsAuthorityTrust(account.accountKey, account.devices.get(value.signerDeviceId)!.signing.privateKey, value);
  return { sequence: value.sequence, accountKeyGeneration: value.accountKeyGeneration,
    accountKeySequence: value.accountKeySequence, signerDeviceId: value.signerDeviceId,
    record: toBase64Url(sealed.record), recordMac: toBase64Url(sealed.recordMac), signature: toBase64Url(sealed.signature) };
}

it('transfers independent roots to a cold D4 reader without creating a leaf or session', async () => {
  const { srv, projectId } = await setup();
  const reader = device(srv, account, null);
  expect((await reader.groups.authorityStore!.read(OWNER, projectId)).owner).toBeNull();
  const authority = await epochAuthority(reader.groups, projectId, 0);
  expect(authority.members.map(member => member.deviceId)).toEqual(['owner_laptop']);
  expect(authority.roles.users).toEqual([{ userId: OWNER, role: 'owner', since: 0 }]);
  expect((await reader.groups.authorityStore!.read(OWNER, projectId)).owner?.userId).toBe(OWNER);
  expect(reader.sessions.cachedSessions).toBe(0);
});

it('refuses withdrawal and same-sequence forks even with a valid account MAC and certified sibling signature', async () => {
  const { srv, projectId, record } = await setup();
  const reader = device(srv, account, null);
  await loadProjectAuthority(reader.groups, projectId);
  let next: E2eeProjectAuthorityRecord | null = null;
  reader.answer = async (path, _init, response) => path.endsWith('/authority') ? Response.json({ authority: next }) : response;
  await expect(loadProjectAuthority(reader.groups, projectId)).rejects.toThrow(/withdrew/);
  next = await reseal(record, { signerDeviceId: 'owner_desktop' });
  await expect(loadProjectAuthority(reader.groups, projectId)).rejects.toThrow(/rollback or fork/);
  expect((await reader.groups.authorityStore!.read(OWNER, projectId)).accepted?.authority.record).toBe(record.record);
});

it('persists the sequence pin across clients and refuses a server rollback', async () => {
  const { srv, laptop, projectId, record } = await setup();
  const reader = device(srv, account, null);
  const advanced = await reseal(record, { sequence: 2, signerDeviceId: 'owner_desktop' });
  await laptop.groups.api.saveAuthority!(projectId, { ...advanced, expectedSequence: 1 });
  await loadProjectAuthority(reader.groups, projectId);
  const reloaded = device(srv, account, null, { authority: reader.groups.authorityStore });
  reloaded.answer = async (path, _init, response) => path.endsWith('/authority') ? Response.json({ authority: record }) : response;
  await expect(loadProjectAuthority(reloaded.groups, projectId)).rejects.toThrow(/rollback or fork/);
  expect((await reloaded.groups.authorityStore!.read(OWNER, projectId)).accepted?.authority.sequence).toBe(2);
});

it('does not bootstrap owner intent from an absent record, a forged MAC, or an unverified manifest alone', async () => {
  const { srv, projectId, record } = await setup();
  for (const replacement of [null, { ...record, recordMac: 'A'.repeat(43) }]) {
    const reader = device(srv, account, null);
    reader.answer = async (path, _init, response) => path.endsWith('/authority') ? Response.json({ authority: replacement }) : response;
    await expect(epochAuthority(reader.groups, projectId, 0)).rejects.toMatchObject({ code: 'archive-invalid' });
    expect((await reader.groups.authorityStore!.read(OWNER, projectId)).owner).toBeNull();
    expect(reader.sessions.cachedSessions).toBe(0);
  }
});

it('reconciles a lost authority acknowledgement after a confirmed MLS Commit', async () => {
  const { laptop, projectId } = await setup();
  let lost = 0;
  laptop.answer = async (path, init, response) => {
    if (path.endsWith('/authority') && init.method === 'POST' && lost++ === 0) throw new TypeError('lost acknowledgement');
    return response;
  };
  expect(await commitProjectGroup(laptop.groups, projectId)).toEqual({ epoch: 1, keyEpoch: 1 });
  const accepted = await loadProjectAuthority(laptop.groups, projectId);
  expect(accepted?.value.latestKeyEpoch).toBe(1);
  expect(accepted?.value.sequence).toBe(2);
  expect(lost).toBe(1);
});

it('does not persist authority returned after key-session teardown', async () => {
  const { srv, projectId } = await setup();
  const reader = device(srv, account, null);
  reader.answer = async (path, _init, response) => {
    if (path.endsWith('/authority')) confirmKeySessionEnded();
    return response;
  };
  await expect(loadProjectAuthority(reader.groups, projectId)).rejects.toMatchObject({ name: 'AbortError' });
  expect((await reader.groups.authorityStore!.read(OWNER, projectId)).accepted).toBeNull();
});
