import { afterEach, expect, it, vi } from 'vitest';
import { fromHex, projectStateCode } from '@openzcad/crypto';
import { reportingEncryptedProjectStore } from '../apps/web/src/lib/e2ee/encryptionStatusReports';
import {
  encryptionStatusOf,
  resetEncryptionStatus
} from '../apps/web/src/lib/e2ee/encryptionStatus';
import { sharedProject, head } from './support/e2ee-members';
import {
  createEncrypted,
  device,
  makeAccount,
  newServer,
  OWNER,
  OTHER
} from './support/e2ee-documents';
import { memoryVersionPins } from '../apps/web/src/lib/e2ee/versionPins';

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

it('cannot install an older room head after its delayed comparison digest finishes last', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop']);
  const srv = newServer([owner]);
  const writer = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(writer);
  const projectId = document.projectId;
  const older = await writer.documents.loadDocument(projectId);
  await writer.store.saveProjectDocument({
    projectId,
    expectedVersion: document.version,
    document: {
      ...document,
      version: document.version + 1,
      name: 'Newer room state'
    }
  });
  const newer = await writer.documents.loadDocument(projectId);
  const pins = memoryVersionPins();
  const reader = device(srv, owner, null, { pins });
  const room = reader.store.roomAccess();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let entered!: () => void;
  let release!: () => void;
  const atCode = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (algorithm, data) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (
        !paused &&
        new TextDecoder().decode(bytes).includes('v1 project state')
      ) {
        paused = true;
        entered();
        await delayed;
      }
      return digest(algorithm, data);
    });
  const first = room
    .openHead(projectId, older.metadata.head, older.envelope)
    .catch((error: unknown) => error);
  try {
    await Promise.race([
      atCode,
      first.then(() => {
        throw new Error('The old head never reached its state-code digest.');
      })
    ]);
    await room.openHead(projectId, newer.metadata.head, newer.envelope);
    release();
    await first;
  } finally {
    release();
    spy.mockRestore();
  }
  expect((await pins.read(OWNER, projectId))?.documentVersion).toBe(
    newer.metadata.head.documentVersion
  );
  expect(room.currentHead(projectId)?.version).toBe(
    newer.metadata.head.documentVersion
  );
  expect(room.currentHead(projectId)?.document.name).toBe('Newer room state');
  expect(reader.store.stateCode!(projectId)).toBe(
    (
      await projectStateCode({
        versionHash: fromHex(newer.metadata.head.versionHash),
        documentVersion: newer.metadata.head.documentVersion,
        signerKeyHash: owner.list.identityKeyHash
      })
    ).code
  );
}, 30_000);

it('keeps a newer room head when an earlier successful account save finishes its digest last', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop']);
  const srv = newServer([owner]);
  const writer = device(srv, owner, 'owner_laptop');
  const { document } = await createEncrypted(writer);
  const projectId = document.projectId;
  const room = writer.store.roomAccess();
  const base = room.currentHead(projectId)!;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let entered!: () => void;
  let release!: () => void;
  const atCode = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let codes = 0;
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(async (algorithm, data) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // This writer already holds its base; pause the newly accepted write.
      if (
        new TextDecoder().decode(bytes).includes('v1 project state') &&
        ++codes === 1
      ) {
        entered();
        await delayed;
      }
      return digest(algorithm, data);
    });
  const saving = {
    ...document,
    version: document.version + 1,
    name: 'Earlier account save'
  };
  const first = writer.store.saveProjectDocument({
    projectId,
    expectedVersion: document.version,
    document: saving
  });
  try {
    await Promise.race([
      atCode,
      first.then(() => {
        throw new Error('The save never reached its state-code digest.');
      })
    ]);
    const saved = head(srv, projectId);
    expect(saved.document_version).toBe(saving.version);
    const sealed = await room.seal(
      projectId,
      { ...saving, version: saving.version + 1, name: 'Later room head' },
      {
        ...base,
        version: saved.document_version,
        hash: saved.version_hash,
        document: saving
      }
    );
    await writer.documents.saveDocument(
      projectId,
      {
        expectedVersion: saving.version,
        signerDeviceId: sealed.signerDeviceId,
        signature: sealed.signature,
        wrappedVersionKey: sealed.wrappedVersionKey
      },
      sealed.envelope
    );
    const latest = await writer.documents.loadDocument(projectId);
    await room.openHead(projectId, latest.metadata.head, latest.envelope);
    release();
    expect((await first).version).toBe(saving.version); // The earlier write did land.
    expect(room.currentHead(projectId)?.version).toBe(
      latest.metadata.head.documentVersion
    );
    expect(room.currentHead(projectId)?.document.name).toBe('Later room head');
    expect(writer.store.stateCode!(projectId)).toBe(
      (
        await projectStateCode({
          versionHash: fromHex(latest.metadata.head.versionHash),
          documentVersion: latest.metadata.head.documentVersion,
          signerKeyHash: owner.list.identityKeyHash
        })
      ).code
    );
  } finally {
    release();
    spy.mockRestore();
  }
}, 30_000);
