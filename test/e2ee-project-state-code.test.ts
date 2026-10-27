import { afterEach, expect, it } from 'vitest';
import { fromHex, projectStateCode } from '@openzcad/crypto';
import { reportingEncryptedProjectStore } from '../apps/web/src/lib/e2ee/encryptionStatusReports';
import {
  encryptionStatusOf,
  resetEncryptionStatus
} from '../apps/web/src/lib/e2ee/encryptionStatus';
import { sharedProject, head } from './support/e2ee-members';
import { device, makeAccount, OWNER, OTHER } from './support/e2ee-documents';

afterEach(resetEncryptionStatus);

it('compares the same verified saved head across accounts and a cold reader, using its signer identity', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop']);
  const other = await makeAccount(OTHER, ['other_laptop']);
  const { srv, laptop, member, projectId } = await sharedProject(
    [owner, other],
    owner,
    other,
    'editor'
  );
  const expected = async (identityKeyHash: Uint8Array) => {
    const saved = head(srv, projectId);
    return (
      await projectStateCode({
        versionHash: fromHex(saved.version_hash),
        documentVersion: saved.document_version,
        signerKeyHash: identityKeyHash
      })
    ).code;
  };
  expect(laptop.store.stateCode!(projectId)).toBe(
    await expected(owner.list.identityKeyHash)
  );
  const a = reportingEncryptedProjectStore(laptop.store, () => true);
  const first = await a.loadProject(projectId);
  const named = await a.saveRevision({
    projectId,
    document: first,
    expectedVersion: first.version,
    reason: 'Before edit'
  });
  const oldRevision = named.revisions.at(-1)!.revisionId;
  const previousCode = laptop.store.stateCode!(projectId);
  const b = reportingEncryptedProjectStore(member.store, () => true);
  const current = await b.loadProject(projectId);
  await b.saveProjectDocument({
    projectId,
    expectedVersion: current.version,
    document: { ...current, version: current.version + 1, name: 'Editor state' }
  });
  const editorCode = await expected(other.list.identityKeyHash);
  expect(member.store.stateCode!(projectId)).toBe(editorCode);
  expect(editorCode).not.toBe(previousCode);
  const delivered = await laptop.documents.loadDocument(projectId);
  await a
    .roomAccess()
    .openHead(projectId, delivered.metadata.head, delivered.envelope);
  expect(laptop.store.stateCode!(projectId)).toBe(editorCode);
  await a.loadProject(projectId);
  expect(laptop.store.stateCode!(projectId)).toBe(editorCode);
  expect(encryptionStatusOf(projectId).projectStateCode).toBe(editorCode);
  // Reading an old named revision does not relabel it as the current state.
  expect(await a.loadRevision(projectId, oldRevision)).not.toBeNull();
  expect(encryptionStatusOf(projectId).projectStateCode).toBe(editorCode);
  const cold = device(srv, owner, null, { members: [other] });
  expect(cold.store.stateCode!(projectId)).toBeNull();
  await reportingEncryptedProjectStore(cold.store, () => true).loadProject(
    projectId
  );
  expect(cold.store.stateCode!(projectId)).toBe(editorCode);
  expect(cold.sessions.cachedSessions).toBe(0);
}, 30_000);
