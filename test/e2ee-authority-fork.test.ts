import { expect, it } from 'vitest';
import {
  EnvelopeKey,
  decodeKeyArchiveBody,
  decryptProjectEnvelope,
  encodeKeyArchiveBody,
  encryptProjectEnvelope,
  epochBinding,
  fromBase64Url,
  fromHex,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  unwrapKey,
  wrapKey
} from '@openzcad/crypto';
import {
  epochAuthority,
  commitProjectGroup
} from '../apps/web/src/lib/e2ee/projectGroups';
import { rememberExpectedProjectOwner } from '../apps/web/src/lib/e2ee/projectAuthority';
import { memoryMlsSessionStore } from '../apps/web/src/lib/e2ee/mls/sessionStore';
import { sealDocumentJob } from '../apps/web/src/lib/e2ee/decodeJobs';
import { device, makeAccount, OWNER, OTHER } from './support/e2ee-documents';
import { sharedProject, head, memberRow } from './support/e2ee-members';

it('rejects a policy-valid competing epoch that contradicts an honest account authority record', async () => {
  const owner = await makeAccount(OWNER, ['owner_laptop']);
  const other = await makeAccount(OTHER, ['other_laptop']);
  const { srv, laptop, member, projectId, document } = await sharedProject(
    [owner, other],
    owner,
    other,
    'editor'
  );
  const ref = { userId: OTHER, deviceId: 'other_laptop', projectId };
  const forkStore = memoryMlsSessionStore();
  await forkStore.getOrCreateStateKey(
    OTHER,
    (await member.mls.loadStateKey(OTHER))!
  );
  const saved = (await member.mls.loadSession(OTHER, projectId))!;
  const { revision: _, ...copy } = saved;
  await forkStore.writeSessionIfCurrent(0, copy);
  const fork = device(srv, other, 'other_laptop', {
    mls: forkStore,
    members: [owner]
  });
  const leaves = (await member.groups.api.leaves(projectId)).leaves;
  const directory = {
    lists: [owner.list, other.list],
    certifications: leaves.map((leaf) => ({
      userId: leaf.userId,
      deviceId: leaf.deviceId,
      leafKey: fromBase64Url(leaf.leafKey),
      certification: fromBase64Url(leaf.certification)
    }))
  };
  const demoted = await commitProjectGroup(laptop.groups, projectId, {
    setRoles: [{ userId: OTHER, role: 'viewer' }]
  });
  const honest = (await laptop.groups.api.authority!(projectId)).authority!;
  const material = await laptop.sessions.epochMaterial({
    userId: OWNER,
    deviceId: 'owner_laptop',
    projectId
  });
  await fork.sessions.commit(ref, directory, {});
  const competing = await fork.sessions.previewPending(ref, directory);
  expect(competing.epoch).toBe(demoted.keyEpoch);
  // The real viewer-accessible key/authenticator encrypt a competing, valid
  // public transcript that retains the old editor role and owner manifest.
  const archive = (
    await laptop.groups.api.archives(projectId, { keyEpoch: demoted.keyEpoch })
  ).archives[0]!;
  const wrapping = {
    purpose: 'version-key' as const,
    projectId,
    keyEpoch: demoted.keyEpoch,
    kind: 'key-archive' as const,
    versionId: `key-archive:${demoted.keyEpoch}`
  };
  const oldKey = await unwrapKey(
    material.projectKey,
    fromBase64Url(archive.wrappedVersionKey),
    wrapping
  );
  const opened = await decryptProjectEnvelope(
    oldKey,
    fromBase64Url(archive.envelope)
  );
  const body = decodeKeyArchiveBody(opened.plaintext, opened.header);
  const replacement = EnvelopeKey.generate();
  const envelope = await encryptProjectEnvelope(
    replacement,
    opened.header,
    encodeKeyArchiveBody(
      { ...body, epochRecord: competing.epochRecord! },
      opened.header
    )
  );
  const signing = other.devices.get('other_laptop')!.signing.privateKey;
  srv.db
    .prepare(
      'UPDATE e2ee_key_archives SET envelope=?, wrapped_version_key=?, signature=?, signer_device_id=? WHERE project_id=? AND key_epoch=?'
    )
    .run(
      toBase64Url(envelope),
      toBase64Url(
        await wrapKey(material.projectKey, replacement.bytes, wrapping)
      ),
      toBase64Url(await signProjectEnvelope(signing, envelope)),
      'other_laptop',
      projectId,
      demoted.keyEpoch
    );
  // Without a terminal-state pin, the transcript is policy-valid. This is
  // the exact distinction the historical verifier must enforce.
  const withoutTerminal = device(srv, owner, null, { members: [other] });
  await rememberExpectedProjectOwner(
    withoutTerminal.groups,
    projectId,
    owner.list
  );
  withoutTerminal.answer = async (path, _init, response) =>
    path.endsWith('/authority') ? Response.json({ authority: null }) : response;
  expect(
    (
      await epochAuthority(withoutTerminal.groups, projectId, demoted.keyEpoch)
    ).roles.users.find((user) => user.userId === OTHER)?.role
  ).toBe('editor');
  memberRow(srv, projectId, OTHER, 'editor');
  const before = head(srv, projectId);
  const sealed = await sealDocumentJob({
    type: 'seal-document',
    header: {
      kind: 'document',
      projectId,
      documentVersion: before.document_version + 1,
      previousVersionHash: fromHex(before.version_hash),
      keyEpoch: demoted.keyEpoch,
      epochBindingHash: await epochBinding(
        projectId,
        demoted.keyEpoch,
        material.epochAuthenticator
      ),
      schemaVersion: 1
    },
    document: { ...document, version: before.document_version + 1 },
    revisionVersionHashes: new Map()
  });
  const hash = toHex(sealed.versionHash);
  await member.documents.saveDocument(
    projectId,
    {
      expectedVersion: before.document_version,
      signerDeviceId: 'other_laptop',
      signature: toBase64Url(
        await signProjectEnvelope(signing, sealed.envelope)
      ),
      wrappedVersionKey: toBase64Url(
        await wrapKey(material.projectKey, sealed.versionKey, {
          purpose: 'version-key',
          projectId,
          keyEpoch: demoted.keyEpoch,
          kind: 'document',
          versionId: hash
        })
      )
    },
    sealed.envelope
  );
  expect((await laptop.groups.api.authority!(projectId)).authority).toEqual(
    honest
  );
  const cold = device(srv, owner, null, { members: [other] });
  await expect(
    epochAuthority(cold.groups, projectId, demoted.keyEpoch)
  ).rejects.toThrow(/history does not reach/);
  await expect(cold.store.loadProject(projectId)).rejects.toMatchObject({
    status: 503,
    code: 'PROJECT_DOCUMENT_UNAVAILABLE',
    details: { e2eeIntegrity: 'authority' }
  });
  expect(cold.sessions.cachedSessions).toBe(0);
}, 30_000);
