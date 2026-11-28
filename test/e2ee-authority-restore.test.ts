/**
 * Issue #1704: an encrypted project whose authority record the account no
 * longer returns, while a device still holds the record it verified. The
 * device keeps refusing, whoever withholds the record and however; these
 * tests pin that, and the one way back: the owner's confirmed restoration
 * from that device's own pin.
 */
import { beforeAll, expect, it } from 'vitest';
import {
  decodeMlsAuthorityManifest,
  decodeMlsAuthorityTrust,
  fromBase64Url,
  signMlsAuthorityManifest,
  signMlsAuthorityTrust,
  toBase64Url,
  toHex,
  type MlsAuthorityTrust
} from '@openzcad/crypto';
import {
  decodeE2eeFrame,
  encodeE2eeFrame,
  type E2eeDocumentHeadMetadata,
  type E2eeProjectAuthorityRecord,
  type E2eeSaveProjectAuthorityRequest
} from '@openzcad/shared';
import {
  AUTHORITY_RESTORE_CONFIRMATION,
  loadProjectAuthority,
  projectAuthorityRecovery,
  ProjectAuthorityError,
  restoreProjectAuthority
} from '../apps/web/src/lib/e2ee/projectAuthority';
import {
  AUTHORITY_WITHDRAWN_PROBLEM,
  IDENTITY_DISCONTINUED_PROBLEM
} from '../apps/web/src/lib/e2ee/encryptionStatus';
import {
  commitProjectGroup,
  epochAuthority,
  ProjectGroupError
} from '../apps/web/src/lib/e2ee/projectGroups';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import { verifyRestoredAuthority } from '../apps/web/src/lib/e2ee/pageDeviceRemoval';
import {
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  OTHER,
  OWNER,
  reload,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

let owner: Account;
beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
});

interface Row {
  sequence: number;
  signer_device_id: string;
  record: string;
}
const stored = (srv: Server, projectId: string) =>
  rows<Row>(
    srv,
    'SELECT sequence, signer_device_id, record FROM e2ee_project_authority WHERE user_id = ? AND project_id = ?',
    OWNER,
    projectId
  );
const withdraw = (srv: Server, projectId: string) =>
  srv.db
    .prepare('DELETE FROM e2ee_project_authority WHERE project_id = ?')
    .run(projectId);
const pins = (d: Device, projectId: string) =>
  d.groups.authorityStore!.read(OWNER, projectId);
/** Counts the device's authority writes that reach the Worker. */
function writes(d: Device): { count: number } {
  const seen = { count: 0 };
  d.before = async (path, init) => {
    if (path.endsWith('/authority') && init.method === 'POST') seen.count++;
  };
  return seen;
}
const refusal = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) => error
  );

/** An encrypted project its creating laptop verified and pinned. */
async function pinnedProject(account = owner) {
  const srv = newServer([account]);
  const laptop = device(srv, account, 'owner_laptop');
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  await loadProjectAuthority(laptop.groups, projectId);
  const pinned = await pins(laptop, projectId);
  expect(pinned.accepted).not.toBeNull();
  return { srv, laptop, projectId, document, pinned };
}

/** The pinned record sealed again with `changes`, as a device would. */
async function reseal(
  record: E2eeProjectAuthorityRecord,
  changes: Partial<MlsAuthorityTrust>,
  account = owner
): Promise<E2eeProjectAuthorityRecord> {
  const value = {
    ...decodeMlsAuthorityTrust(fromBase64Url(record.record)),
    ...changes
  };
  const sealed = await signMlsAuthorityTrust(
    account.accountKey,
    account.devices.get(value.signerDeviceId)!.signing.privateKey,
    value
  );
  return {
    sequence: value.sequence,
    accountKeyGeneration: value.accountKeyGeneration,
    accountKeySequence: value.accountKeySequence,
    signerDeviceId: value.signerDeviceId,
    record: toBase64Url(sealed.record),
    recordMac: toBase64Url(sealed.recordMac),
    signature: toBase64Url(sealed.signature)
  };
}

it('refuses a withdrawn record by default, naming the owner’s way back, with every pin kept and nothing written', async () => {
  const { srv, laptop, projectId, pinned } = await pinnedProject();
  withdraw(srv, projectId);
  const posts = writes(laptop);

  const loaded = await refusal(loadProjectAuthority(laptop.groups, projectId));
  expect(loaded).toBeInstanceOf(ProjectAuthorityError);
  expect(loaded).toMatchObject({
    code: 'authority-withdrawn',
    message: AUTHORITY_WITHDRAWN_PROBLEM
  });
  const historical = await refusal(epochAuthority(laptop.groups, projectId, 0));
  expect(historical).toBeInstanceOf(ProjectGroupError);
  expect(historical).toMatchObject({
    code: 'archive-invalid',
    detail: 'authority-withdrawn',
    message: AUTHORITY_WITHDRAWN_PROBLEM
  });
  const opened = await refusal(laptop.store.loadProject(projectId));
  expect(opened).toBeInstanceOf(EncryptedProjectIntegrityError);
  expect(opened).toMatchObject({
    reason: 'authority',
    message: AUTHORITY_WITHDRAWN_PROBLEM
  });
  expect(await projectAuthorityRecovery(laptop.groups, projectId)).toBe(
    'restorable'
  );

  // Fail closed: nothing adopted, nothing forgotten, nothing written.
  expect(await pins(laptop, projectId)).toEqual(pinned);
  expect(stored(srv, projectId)).toHaveLength(0);
  expect(posts.count).toBe(0);
});

it('never lets a server that withholds the record past verification, with or without the owner’s confirmation', async () => {
  const { srv, laptop, projectId, document, pinned } = await pinnedProject();
  const before = stored(srv, projectId);
  // The account still stores the record; the server only stops returning it.
  laptop.answer = async (path, init, response) =>
    path.endsWith('/authority') && init.method !== 'POST'
      ? Response.json({ authority: null })
      : response;
  const posts = writes(laptop);

  // Opening, saving and committing all stay refused.
  for (const work of [
    () => laptop.store.loadProject(projectId),
    () =>
      laptop.store.saveProjectDocument({
        projectId,
        expectedVersion: document.version,
        document: edited(document, 'Renamed')
      }),
    () => commitProjectGroup(laptop.groups, projectId)
  ]) {
    expect(await refusal(work())).toBeInstanceOf(Error);
  }
  expect(await pins(laptop, projectId)).toEqual(pinned);
  expect(stored(srv, projectId)).toEqual(before);

  // No confirmation, no restoration: not even a request.
  for (const confirmation of ['', 'yes', 'Restore']) {
    expect(
      await refusal(
        restoreProjectAuthority(laptop.groups, projectId, confirmation)
      )
    ).toMatchObject({ code: 'restore-refused' });
  }
  expect(posts.count).toBe(0);

  // Confirmed: the restoration is the device's own pinned state, which the
  // Worker stores only while the account holds no record. Here it holds
  // one, so nothing is replaced, and the device still refuses the project.
  expect(
    await refusal(
      restoreProjectAuthority(
        laptop.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    )
  ).toMatchObject({ code: 'restore-refused' });
  expect(posts.count).toBe(1);
  expect(stored(srv, projectId)).toEqual(before);
  expect(await pins(laptop, projectId)).toEqual(pinned);
  expect(
    await refusal(loadProjectAuthority(laptop.groups, projectId))
  ).toMatchObject({ code: 'authority-withdrawn' });
});

it('restores the record from the owner’s pin after confirmation, and the project opens, saves and syncs again', async () => {
  const { srv, laptop, projectId, pinned } = await pinnedProject();
  // Another browser of the account and a read-only device pinned it too.
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  const desktopPinned = await pins(desktop, projectId);
  withdraw(srv, projectId);

  const restored = await restoreProjectAuthority(
    laptop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  const before = decodeMlsAuthorityTrust(
    fromBase64Url(pinned.accepted!.authority.record)
  );
  // The same roots and membership state, one sequence on, by this device.
  expect(restored.value).toEqual({
    ...before,
    sequence: before.sequence + 1,
    signerDeviceId: 'owner_laptop'
  });
  expect(stored(srv, projectId)).toEqual([
    {
      sequence: before.sequence + 1,
      signer_device_id: 'owner_laptop',
      record: restored.record.record
    }
  ]);
  const after = await pins(laptop, projectId);
  expect(after.owner).toEqual(pinned.owner);
  expect(after.accepted?.authority).toEqual(restored.record);
  expect(await projectAuthorityRecovery(laptop.groups, projectId)).toBe('none');

  // The project is available again: open, save, reload, rotate keys.
  const opened = await reload(srv, laptop).store.loadProject(projectId);
  expect(opened.projectId).toBe(projectId);
  const saved = await laptop.store.saveProjectDocument({
    projectId,
    expectedVersion: opened.version,
    document: edited(opened, 'Recovered')
  });
  expect(saved.version).toBe(opened.version + 1);
  expect(await commitProjectGroup(laptop.groups, projectId)).toEqual({
    epoch: 1,
    keyEpoch: 1
  });

  // The other browser held the earlier pin: the restored record is simply
  // a newer one to it, checked against that pin with no confirmation.
  expect(desktopPinned.accepted?.authority.sequence).toBe(before.sequence);
  const again = await reload(srv, desktop).store.loadProject(projectId);
  expect(again.name).toBe('Recovered');
  // And a device that never saw the project verifies it from scratch.
  const cold = device(srv, owner, null);
  expect((await cold.store.loadProject(projectId)).name).toBe('Recovered');
});

it('restores an older project at the sequence and key epoch its device last verified', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  await commitProjectGroup(laptop.groups, projectId);
  await commitProjectGroup(laptop.groups, projectId);
  const pinned = (await pins(laptop, projectId)).accepted!;
  const before = decodeMlsAuthorityTrust(
    fromBase64Url(pinned.authority.record)
  );
  expect(before).toMatchObject({ sequence: 3, latestKeyEpoch: 2 });
  // A project made after the withdrawal is untouched by it.
  withdraw(srv, projectId);
  const recent = (await createEncrypted(laptop, 'Recent')).document.projectId;
  expect(await projectAuthorityRecovery(laptop.groups, recent)).toBe('none');

  const restored = await restoreProjectAuthority(
    laptop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(restored.value).toMatchObject({
    sequence: 4,
    latestKeyEpoch: 2,
    latestGroupInfo: before.latestGroupInfo,
    manifest: before.manifest
  });
  // The ordinary compare-and-swap continues from the restored sequence.
  expect(await commitProjectGroup(laptop.groups, projectId)).toEqual({
    epoch: 3,
    keyEpoch: 3
  });
  expect(stored(srv, projectId)[0]!.sequence).toBe(5);
  expect((await laptop.store.loadProject(recent)).name).toBe('Recent');
});

it('keeps a record sealed by a since-removed device restorable by a device that is still certified', async () => {
  const account = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  const { srv, laptop, projectId, pinned } = await pinnedProject(account);
  // The other browser wrote the newest record before it was removed.
  const sibling = await reseal(
    pinned.accepted!.authority,
    { sequence: 2, signerDeviceId: 'owner_desktop' },
    account
  );
  await laptop.groups.api.saveAuthority!(projectId, {
    ...sibling,
    expectedSequence: 1
  });
  await loadProjectAuthority(laptop.groups, projectId);
  await account.revoke(srv.db, 'owner_desktop');
  withdraw(srv, projectId);

  const restored = await restoreProjectAuthority(
    laptop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(restored.value).toMatchObject({
    sequence: 3,
    signerDeviceId: 'owner_laptop'
  });
  expect(
    (await loadProjectAuthority(laptop.groups, projectId))?.record
  ).toEqual(restored.record);
});

it('lets two devices restore at once: one record is stored and both verify it', async () => {
  const { srv, laptop, projectId, pinned } = await pinnedProject();
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  withdraw(srv, projectId);
  // The laptop's restoration lands between the desktop's read and write.
  let raced: E2eeSaveProjectAuthorityRequest | null = null;
  desktop.before = async (path, init) => {
    if (!path.endsWith('/authority') || init.method !== 'POST' || raced) return;
    const first = await reseal(pinned.accepted!.authority, {
      sequence: 2,
      signerDeviceId: 'owner_laptop'
    });
    raced = { ...first, expectedSequence: 1, restoreMissing: true };
    await laptop.groups.api.saveAuthority!(projectId, raced);
  };

  const restored = await restoreProjectAuthority(
    desktop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(raced).not.toBeNull();
  // The desktop's own record lost; it verified and pinned the laptop's.
  expect(restored.record.record).toBe(raced!.record);
  expect(stored(srv, projectId)).toEqual([
    { sequence: 2, signer_device_id: 'owner_laptop', record: raced!.record }
  ]);
  expect((await pins(desktop, projectId)).accepted?.authority.record).toBe(
    raced!.record
  );
  // The laptop, restoring next, finds nothing missing and verifies the same.
  expect(
    (
      await restoreProjectAuthority(
        laptop.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).record.record
  ).toBe(raced!.record);
  expect(stored(srv, projectId)).toHaveLength(1);
});

it('counts an ordinary publish that lands right after the restoration as the restoration succeeding', async () => {
  const { srv, laptop, projectId, pinned } = await pinnedProject();
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  withdraw(srv, projectId);
  const before = pinned.accepted!.authority.sequence;
  // The Worker stores the laptop's record. Before the laptop reads it back,
  // the desktop publishes the next one by the ordinary compare-and-swap.
  let successor: E2eeProjectAuthorityRecord | null = null;
  laptop.answer = async (path, init, response) => {
    if (
      path.endsWith('/authority') &&
      init.method === 'POST' &&
      response.ok &&
      !successor
    ) {
      const restoredRequest = JSON.parse(
        init.body as string
      ) as E2eeSaveProjectAuthorityRequest;
      expect(restoredRequest).toMatchObject({
        sequence: before + 1,
        restoreMissing: true
      });
      successor = await reseal(restoredRequest, {
        sequence: before + 2,
        signerDeviceId: 'owner_desktop'
      });
      await desktop.groups.api.saveAuthority!(projectId, {
        ...successor,
        expectedSequence: before + 1
      });
    }
    return response;
  };

  const restored = await restoreProjectAuthority(
    laptop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(successor).not.toBeNull();
  // The laptop verified and pinned the desktop's newer record: a success.
  expect(restored.record).toEqual(successor);
  expect(restored.value).toMatchObject({
    sequence: before + 2,
    signerDeviceId: 'owner_desktop'
  });
  expect((await pins(laptop, projectId)).accepted?.authority).toEqual(
    successor
  );
  expect(stored(srv, projectId)).toEqual([
    {
      sequence: before + 2,
      signer_device_id: 'owner_desktop',
      record: successor!.record
    }
  ]);
  expect(await projectAuthorityRecovery(laptop.groups, projectId)).toBe('none');
  expect(
    (await reload(srv, laptop).store.loadProject(projectId)).projectId
  ).toBe(projectId);
});

it('still fails the read-back when the account returns other bytes at the restored sequence, or nothing', async () => {
  // Another record at the very sequence the Worker acknowledged.
  {
    const { srv, laptop, projectId, pinned } = await pinnedProject();
    withdraw(srv, projectId);
    let acknowledged = false;
    laptop.answer = async (path, init, response) => {
      if (!path.endsWith('/authority')) return response;
      if (init.method === 'POST') {
        acknowledged = response.ok;
        return response;
      }
      if (!acknowledged) return response;
      const { authority } = (await response.json()) as {
        authority: E2eeProjectAuthorityRecord;
      };
      return Response.json({
        authority: await reseal(authority, { signerDeviceId: 'owner_desktop' })
      });
    };
    await expect(
      restoreProjectAuthority(
        laptop.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).rejects.toThrow(/did not retain the authority record/);
    expect(acknowledged).toBe(true);
    // PR #2400 re-check: the refused read-back pinned nothing, neither the
    // owner, nor the accepted record, nor the roots.
    expect(await pins(laptop, projectId)).toEqual(pinned);
    // So the record the Worker did store is accepted once the account
    // serves it, instead of refused as a fork of bytes this device rejected.
    laptop.answer = undefined;
    const kept = stored(srv, projectId);
    expect(kept).toHaveLength(1);
    expect(
      (await loadProjectAuthority(laptop.groups, projectId))?.record.record
    ).toBe(kept[0]!.record);
    expect(
      (await reload(srv, laptop).store.loadProject(projectId)).projectId
    ).toBe(projectId);
  }
  // The record withheld again right after the acknowledgement.
  {
    const { srv, laptop, projectId, pinned } = await pinnedProject();
    withdraw(srv, projectId);
    let acknowledged = false;
    laptop.answer = async (path, init, response) => {
      if (!path.endsWith('/authority')) return response;
      if (init.method === 'POST') {
        acknowledged = response.ok;
        return response;
      }
      return acknowledged ? Response.json({ authority: null }) : response;
    };
    await expect(
      restoreProjectAuthority(
        laptop.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).rejects.toMatchObject({ code: 'authority-withdrawn' });
    expect(acknowledged).toBe(true);
    expect(await pins(laptop, projectId)).toEqual(pinned);
  }
});

it('checks the history through the saved head’s key epoch, not only the restored record’s', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  // The desktop last verified the project at key epoch 0.
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  // The laptop then rotated the keys and saved under the new epoch.
  expect(await commitProjectGroup(laptop.groups, projectId)).toEqual({
    epoch: 1,
    keyEpoch: 1
  });
  const current = await laptop.store.loadProject(projectId);
  await laptop.store.saveProjectDocument({
    projectId,
    expectedVersion: current.version,
    document: edited(current, 'Rotated')
  });
  withdraw(srv, projectId);
  // The account no longer serves the newer epoch's key archive.
  const withoutNewerArchive: Device['answer'] = async (
    path,
    _init,
    response
  ) => {
    if (!path.includes('/keys/archives') || !response.ok) return response;
    const body = (await response.json()) as {
      archives: { keyEpoch: number }[];
    };
    return Response.json({
      ...body,
      archives: body.archives.filter((archive) => archive.keyEpoch < 1)
    });
  };
  desktop.answer = withoutNewerArchive;

  const restored = await restoreProjectAuthority(
    desktop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(restored.value.latestKeyEpoch).toBe(0);
  const deps = {
    groups: desktop.groups,
    documents: desktop.documents,
    pins: desktop.pins
  };
  const versionPin = await desktop.pins.read(OWNER, projectId);
  // The restored record's own epoch verifies, which is all the check used
  // to cover; the saved head needs epoch 1, and opening refuses.
  await epochAuthority(desktop.groups, projectId, 0);
  const outcome = await verifyRestoredAuthority(deps, projectId, 0);
  expect(outcome).toMatchObject({ verified: false, savedVersionChecked: true });
  expect(outcome.problem).toBeTruthy();
  const reopened = reload(srv, desktop);
  reopened.answer = withoutNewerArchive;
  expect(await refusal(reopened.store.loadProject(projectId))).toBeInstanceOf(
    Error
  );
  // Once the account serves that archive, the same check passes and the
  // project opens: the answer follows what opening would find.
  desktop.answer = undefined;
  expect(await verifyRestoredAuthority(deps, projectId, 0)).toEqual({
    verified: true,
    savedVersionChecked: true
  });
  // The check is the one opening runs, but it moves no version pin: the
  // page that opens the project accepts the head itself.
  expect(await desktop.pins.read(OWNER, projectId)).toEqual(versionPin);
  expect((await reload(srv, desktop).store.loadProject(projectId)).name).toBe(
    'Rotated'
  );
  desktop.answer = withoutNewerArchive;

  // A saved version that cannot be read is reported as not checked, never
  // as verified through it.
  expect(
    await verifyRestoredAuthority(
      {
        ...deps,
        documents: {
          ...desktop.documents,
          loadDocument: async () => {
            throw new Error('offline');
          }
        }
      },
      projectId,
      0
    )
  ).toEqual({ verified: true, savedVersionChecked: false });
});

/** Rewrites what the account says beside a document read's envelope. */
const relabelled =
  (
    change: (metadata: E2eeDocumentHeadMetadata) => E2eeDocumentHeadMetadata,
    then?: Device['answer']
  ): Device['answer'] =>
  async (path, init, response) => {
    if (!/\/document(\?|$)/.test(path) || !response.ok)
      return then ? then(path, init, response) : response;
    const { metadata, payload } = decodeE2eeFrame(
      new Uint8Array(await response.arrayBuffer())
    );
    return new Response(
      encodeE2eeFrame(change(metadata as E2eeDocumentHeadMetadata), payload),
      { status: response.status, headers: response.headers }
    );
  };
/**
 * An account that serves every key archive but `keyEpoch`'s; with `asked`,
 * only when that one archive is asked for, so a later epoch's chain, which
 * lists the archives, still verifies.
 */
const withoutArchive =
  (keyEpoch: number, asked = false): NonNullable<Device['answer']> =>
  async (path, _init, response) => {
    if (
      !path.includes('/keys/archives') ||
      !response.ok ||
      (asked && !path.includes(`keyEpoch=${keyEpoch}`))
    )
      return response;
    const body = (await response.json()) as {
      archives: { keyEpoch: number }[];
    };
    return Response.json({
      ...body,
      archives: body.archives.filter((archive) => archive.keyEpoch !== keyEpoch)
    });
  };

// PR #2400 re-check: the account's key-epoch labels are not authenticated.
it('does not report a restored project verified on the account’s word about its saved versions’ key epochs', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  await commitProjectGroup(laptop.groups, projectId);
  const current = await laptop.store.loadProject(projectId);
  await laptop.store.saveProjectDocument({
    projectId,
    expectedVersion: current.version,
    document: edited(current, 'Rotated')
  });
  withdraw(srv, projectId);
  // The account withholds key epoch 1's archive, and labels the versions
  // saved under it as key epoch 0, the restored record's own.
  const mislabelled = relabelled(
    (metadata) => ({
      ...metadata,
      head: { ...metadata.head, keyEpoch: 0 },
      log: metadata.log.map((entry) => ({ ...entry, keyEpoch: 0 }))
    }),
    withoutArchive(1)
  );
  desktop.answer = mislabelled;
  await restoreProjectAuthority(
    desktop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );

  const outcome = await verifyRestoredAuthority(
    {
      groups: desktop.groups,
      documents: desktop.documents,
      pins: desktop.pins
    },
    projectId,
    0
  );
  // Opening refuses, so the check must not report the project verified.
  const reopened = reload(srv, desktop);
  reopened.answer = mislabelled;
  expect(await refusal(reopened.store.loadProject(projectId))).toBeInstanceOf(
    Error
  );
  expect(outcome).toMatchObject({ verified: false, savedVersionChecked: true });
  expect(outcome.problem).toBeTruthy();
});

// PR #2400 re-check: the first page of the log is not the whole history.
it('checks the key epochs of saved versions on later pages of the account’s log', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  const desktop = device(srv, owner, 'owner_desktop');
  await desktop.store.loadProject(projectId);
  // Since then: a save at key epoch 0, one at 1 and the head at 2.
  let current = await laptop.store.loadProject(projectId);
  for (const [name, rotate] of [
    ['Zero', false],
    ['One', true],
    ['Two', true]
  ] as const) {
    if (rotate) await commitProjectGroup(laptop.groups, projectId);
    const next = edited(current, name);
    const { version } = await laptop.store.saveProjectDocument({
      projectId,
      expectedVersion: current.version,
      document: next
    });
    current = { ...next, version };
  }
  withdraw(srv, projectId);
  // The account does not serve key epoch 1's own archive, and the first
  // page of its log stops before the version saved under that epoch.
  const firstPage = (metadata: E2eeDocumentHeadMetadata) => ({
    ...metadata,
    log: metadata.log.slice(0, 2),
    more: true
  });
  const paged = relabelled(firstPage, withoutArchive(1, true));
  desktop.answer = paged;
  await restoreProjectAuthority(
    desktop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  const deps = {
    groups: desktop.groups,
    documents: desktop.documents,
    pins: desktop.pins
  };
  // Both epochs the first page and the head name verify on their own.
  await epochAuthority(desktop.groups, projectId, 0);
  await epochAuthority(desktop.groups, projectId, 2);

  const outcome = await verifyRestoredAuthority(deps, projectId, 0);
  const reopened = reload(srv, desktop);
  reopened.answer = paged;
  expect(await refusal(reopened.store.loadProject(projectId))).toBeInstanceOf(
    Error
  );
  expect(outcome).toMatchObject({ verified: false, savedVersionChecked: true });
  expect(outcome.problem).toBeTruthy();

  // With that archive served, the paged history verifies and it opens.
  desktop.answer = relabelled(firstPage);
  expect(await verifyRestoredAuthority(deps, projectId, 0)).toEqual({
    verified: true,
    savedVersionChecked: true
  });
  expect((await reload(srv, desktop).store.loadProject(projectId)).name).toBe(
    'Two'
  );
});

it('reports a restored project verified through its saved head when nothing newer is needed', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  withdraw(srv, projectId);
  const restored = await restoreProjectAuthority(
    laptop.groups,
    projectId,
    AUTHORITY_RESTORE_CONFIRMATION
  );
  expect(
    await verifyRestoredAuthority(
      { groups: laptop.groups, documents: laptop.documents, pins: laptop.pins },
      projectId,
      restored.value.latestKeyEpoch
    )
  ).toEqual({ verified: true, savedVersionChecked: true });
  expect(
    (await reload(srv, laptop).store.loadProject(projectId)).projectId
  ).toBe(projectId);
});

it('refuses a record that reappears as a rollback or fork, keeping the pins', async () => {
  const { srv, laptop, projectId } = await pinnedProject();
  await commitProjectGroup(laptop.groups, projectId);
  const pinned = await pins(laptop, projectId);
  const newest = pinned.accepted!.authority;
  expect(newest.sequence).toBe(2);
  withdraw(srv, projectId);
  // The account comes back with a validly sealed, different sequence 2.
  const fork = await reseal(newest, { signerDeviceId: 'owner_desktop' });
  laptop.answer = async (path, init, response) =>
    path.endsWith('/authority') && init.method !== 'POST'
      ? Response.json({ authority: fork })
      : response;
  const posts = writes(laptop);
  await expect(
    restoreProjectAuthority(
      laptop.groups,
      projectId,
      AUTHORITY_RESTORE_CONFIRMATION
    )
  ).rejects.toThrow(/rollback or fork/);
  expect(posts.count).toBe(0);
  expect(await pins(laptop, projectId)).toEqual(pinned);
  expect(stored(srv, projectId)).toHaveLength(0);
});

it('restores nothing when the device’s keys do not prove the pinned owner', async () => {
  // A read-only device holds the pin but cannot sign a record.
  {
    const { srv, projectId } = await pinnedProject();
    const reader = device(srv, owner, null);
    await loadProjectAuthority(reader.groups, projectId);
    withdraw(srv, projectId);
    const posts = writes(reader);
    await expect(
      restoreProjectAuthority(
        reader.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).rejects.toMatchObject({ code: 'restore-refused' });
    expect(posts.count).toBe(0);
  }
  // A device that never verified the project has no pin to restore from.
  {
    const { srv, projectId } = await pinnedProject();
    withdraw(srv, projectId);
    const fresh = device(srv, owner, 'owner_desktop');
    expect(await projectAuthorityRecovery(fresh.groups, projectId)).toBe(
      'none'
    );
    await expect(
      restoreProjectAuthority(
        fresh.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).rejects.toMatchObject({ code: 'restore-refused' });
    expect(stored(srv, projectId)).toHaveLength(0);
  }
  // A pin whose seal does not open under this account's key is no proof.
  {
    const { srv, laptop, projectId, pinned } = await pinnedProject();
    withdraw(srv, projectId);
    await laptop.groups.authorityStore!.update(OWNER, projectId, (current) => ({
      ...current,
      accepted: {
        ...current.accepted!,
        authority: {
          ...current.accepted!.authority,
          recordMac: 'A'.repeat(43)
        }
      }
    }));
    const posts = writes(laptop);
    expect(
      await refusal(
        restoreProjectAuthority(
          laptop.groups,
          projectId,
          AUTHORITY_RESTORE_CONFIRMATION
        )
      )
    ).toBeInstanceOf(Error);
    expect(posts.count).toBe(0);
    expect(stored(srv, projectId)).toHaveLength(0);
    expect((await pins(laptop, projectId)).owner).toEqual(pinned.owner);
  }
});

it('restores nothing for an identity that was set up afresh, or for another account’s project', async () => {
  // The account's keys were erased and set up again (the #1704 beta state).
  {
    const before = await makeAccount(OWNER, ['owner_laptop']);
    const { srv, laptop, projectId, pinned } = await pinnedProject(before);
    withdraw(srv, projectId);
    const after = await makeAccount(OWNER, ['owner_laptop'], [], {
      reuse: before.signingPairs
    });
    const browser = device(srv, after, 'owner_laptop', {
      authority: laptop.groups.authorityStore,
      mls: laptop.mls,
      pins: laptop.pins
    });
    const posts = writes(browser);
    expect(await projectAuthorityRecovery(browser.groups, projectId)).toBe(
      'identity-discontinued'
    );
    expect(
      await refusal(
        restoreProjectAuthority(
          browser.groups,
          projectId,
          AUTHORITY_RESTORE_CONFIRMATION
        )
      )
    ).toMatchObject({
      code: 'identity-discontinued',
      message: IDENTITY_DISCONTINUED_PROBLEM
    });
    expect(posts.count).toBe(0);
    expect(await pins(browser, projectId)).toEqual(pinned);
    expect(stored(srv, projectId)).toHaveLength(0);
  }
  // A member's pin of a project another account owns.
  {
    const { srv, laptop, projectId, pinned } = await pinnedProject();
    const value = decodeMlsAuthorityTrust(
      fromBase64Url(pinned.accepted!.authority.record)
    );
    const key = owner.devices.get('owner_laptop')!.signing.privateKey;
    const manifest = await signMlsAuthorityManifest(key, {
      ...decodeMlsAuthorityManifest(fromBase64Url(value.manifest.statement)),
      ownerUserId: OTHER,
      ownerIdentityKeyHash: toHex(new Uint8Array(32).fill(7))
    });
    const foreign = await reseal(pinned.accepted!.authority, {
      manifest: {
        statement: toBase64Url(manifest.statement),
        signature: toBase64Url(manifest.signature)
      }
    });
    const hash = toHex(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', fromBase64Url(foreign.record))
      )
    );
    await laptop.groups.authorityStore!.update(OWNER, projectId, () => ({
      owner: null,
      manifest: null,
      accepted: { hash, authority: foreign }
    }));
    withdraw(srv, projectId);
    const posts = writes(laptop);
    expect(await projectAuthorityRecovery(laptop.groups, projectId)).toBe(
      'not-owner'
    );
    // The generic withdrawal refusal, with no restoration on offer.
    await expect(
      loadProjectAuthority(laptop.groups, projectId)
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      restoreProjectAuthority(
        laptop.groups,
        projectId,
        AUTHORITY_RESTORE_CONFIRMATION
      )
    ).rejects.toMatchObject({ code: 'restore-refused' });
    expect(posts.count).toBe(0);
    expect(stored(srv, projectId)).toHaveLength(0);
  }
});
