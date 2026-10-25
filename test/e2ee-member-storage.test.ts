/**
 * Member-aware storage for end-to-end encrypted projects (ADR-024 Phase 5,
 * slice 5-2; roadmap L11): Node devices of two accounts (and a third that
 * is never a member) run the real client modules (`projectGroups.ts`,
 * `encryptedProjectStore.ts`) with the in-process MLS engine against the
 * real Worker over SQLite.
 *
 * Members are seeded through MLS: the owner's Commit adds the identity to
 * the group's roles (`setRoles`), and the member's device joins by
 * External Commit with a rejoin PSK it posts as its own through
 * `POST …/keys`. The owner hands that epoch's keys over in process, which
 * stands in for the Welcome that invitations (slice 5-3) bring. The
 * server's `project_members` row mirrors the role, and some cases make it
 * lie, as a compromised server could.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  epochBinding,
  fromHex,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  wrapKey
} from '@openzcad/crypto';
import type { ProjectDocument } from '@openzcad/shared';
import { ApiError } from '../apps/web/src/lib/api';
import { inProcessMls } from '../packages/mls/src/test-support';
import { sealDocumentJob } from '../apps/web/src/lib/e2ee/decodeJobs';
import { certifyLeaf } from '../apps/web/src/lib/e2ee/mls/certify';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  catchUpProjectGroup,
  commitProjectGroup,
  joinProjectGroup,
  postOwnEpochKeys,
  projectKeyForEpoch,
  ProjectGroupError
} from '../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OTHER,
  OWNER,
  count,
  createEncrypted,
  device,
  edited,
  makeAccount,
  newServer,
  reload,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';

const THIRD = 'user_third';

let owner: Account;
let other: Account;
let third: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
  other = await makeAccount(OTHER, ['other_laptop', 'other_desktop']);
  third = await makeAccount(THIRD, ['third_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

type Role = 'editor' | 'viewer';

function memberRow(srv: Server, projectId: string, userId: string, role: Role) {
  srv.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .run(projectId, userId, role, OWNER);
}

const ownerRef = (projectId: string, deviceId = 'owner_laptop') => ({
  userId: OWNER,
  deviceId,
  projectId
});

/** The owner's encrypted project, with OTHER a member of it in `role`. */
async function shared(role: Role) {
  const srv = newServer([owner, other, third]);
  const laptop = device(srv, owner, 'owner_laptop', { members: [other] });
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  memberRow(srv, projectId, OTHER, role);
  await commitProjectGroup(laptop.groups, projectId, {
    setRoles: [{ userId: OTHER, role }]
  });
  // The Welcome's stand-in: epoch 1's keys, handed over in process.
  const member = device(srv, other, 'other_laptop', { members: [owner] });
  await postOwnEpochKeys(
    member.groups,
    projectId,
    1,
    await laptop.sessions.epochMaterial(ownerRef(projectId))
  );
  forgetAllProjectKeys();
  await joinProjectGroup(member.groups, projectId);
  return { srv, laptop, member, projectId, document };
}

/** A fresh browser of the owner that knows OTHER's (and maybe more) lists. */
const ownerDesktop = (srv: Server, members: readonly Account[] = [other]) =>
  device(srv, owner, 'owner_desktop', { members });

async function refusedWith(
  promise: Promise<unknown>,
  status: number,
  code: string
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === status &&
      error.code === code
  );
}

async function integrityRefusal(
  promise: Promise<unknown>,
  reason: EncryptedProjectIntegrityError['reason']
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptedProjectIntegrityError && error.reason === reason
  );
}

function head(srv: Server, projectId: string) {
  return rows<{
    document_version: number;
    version_hash: string;
    key_epoch: number;
    signer_user_id: string | null;
  }>(
    srv,
    `SELECT document_version, version_hash, key_epoch, signer_user_id
     FROM e2ee_project_versions WHERE project_id = ?
     ORDER BY document_version DESC LIMIT 1`,
    projectId
  )[0]!;
}

/**
 * A version signed by `d`'s device with keys it should not have (leaked
 * from the owner's session), sent straight to the Worker: what a stolen
 * key or a hostile client could write past the Worker's own checks.
 */
async function forgeVersion(
  srv: Server,
  d: Device,
  projectId: string,
  base: ProjectDocument,
  keys: { projectKey: Uint8Array; epochAuthenticator: Uint8Array }
) {
  const current = head(srv, projectId);
  const group = rows<{ key_epoch: number }>(
    srv,
    `SELECT key_epoch_base + epoch AS key_epoch FROM e2ee_project_groups
     WHERE project_id = ?`,
    projectId
  )[0]!;
  const documentVersion = current.document_version + 1;
  const document = { ...base, name: 'Forged', version: documentVersion };
  const sealed = await sealDocumentJob({
    type: 'seal-document',
    header: {
      kind: 'document',
      projectId,
      documentVersion,
      previousVersionHash: fromHex(current.version_hash),
      epochBindingHash: await epochBinding(
        projectId,
        group.key_epoch,
        keys.epochAuthenticator
      ),
      schemaVersion: 1,
      keyEpoch: group.key_epoch
    },
    document,
    revisionVersionHashes: new Map()
  });
  const hash = toHex(sealed.versionHash);
  const wrappedVersionKey = toBase64Url(
    await wrapKey(keys.projectKey, sealed.versionKey, {
      purpose: 'version-key',
      projectId,
      keyEpoch: group.key_epoch,
      kind: 'document',
      versionId: hash
    })
  );
  const signer = d.account.devices.get(d.deviceId!)!;
  return d.documents.saveDocument(
    projectId,
    {
      expectedVersion: current.document_version,
      signature: toBase64Url(
        await signProjectEnvelope(signer.signing.privateKey, sealed.envelope)
      ),
      wrappedVersionKey,
      signerDeviceId: signer.deviceId
    },
    sealed.envelope
  );
}

describe('members read and editors write (slice 5-2)', () => {
  it('lets a member read and an editor write, which the owner verifies', async () => {
    const { srv, laptop, member, projectId } = await shared('editor');
    // Without the member's list the owner's browser treats the project as
    // solo and refuses the member's leaf.
    await expect(
      catchUpProjectGroup(reload(srv, laptop).groups, projectId)
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ProjectGroupError && error.code === 'server-mismatch'
    );

    const opened = await member.store.loadProject(projectId);
    expect(opened.name).toBe('Bracket');
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Member edit')
    });
    expect(head(srv, projectId)).toMatchObject({
      signer_user_id: OTHER,
      key_epoch: 2
    });

    // Processing the member's External Commit, the owner posts its own
    // wraps of that epoch: what lets its other devices read it.
    expect(
      count(srv, 'e2ee_project_keys', projectId) // owner 0, 1; member 1, 2
    ).toBe(8);
    await catchUpProjectGroup(laptop.groups, projectId);
    expect(
      rows<{ purpose: string }>(
        srv,
        `SELECT purpose FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ? AND key_epoch = 2
         ORDER BY purpose`,
        projectId,
        OWNER
      ).map((row) => row.purpose)
    ).toEqual(['project-key', 'rejoin-psk']);

    // A fresh owner browser verifies the member's version, its project
    // info and the author's editing role in its epoch.
    const desktop = ownerDesktop(srv);
    const read = await desktop.store.loadProject(projectId);
    expect(read.name).toBe('Member edit');
    expect((await desktop.store.info.read(projectId)).body?.name).toBe(
      'Member edit'
    );
    // And the member's other device reads through its own account's wraps.
    const memberDesktop = device(srv, other, 'other_desktop', {
      members: [owner]
    });
    expect((await memberDesktop.store.loadProject(projectId)).name).toBe(
      'Member edit'
    );

    // The editor's measurements, read and checked by the owner.
    const record = {
      projectId,
      version: 1,
      updatedAt: '2026-10-24T01:00:00.000Z',
      display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
      measurements: []
    } as never;
    await member.measurements.saveProjectMeasurements({
      projectId,
      expectedRevision: 0,
      record
    });
    expect(
      await desktop.measurements.loadProjectMeasurements(projectId)
    ).toEqual({ revision: 1, record });
    // And an encrypted file, stored against the owner's artifact storage.
    const blobId = await member.blobs.archive(projectId, {
      fileName: 'bracket.step',
      contentType: 'model/step',
      kind: 'step-import',
      body: new Blob([new TextEncoder().encode('ISO-10303-21;\n'.repeat(64))])
    });
    expect(
      rows<{ state: string }>(
        srv,
        'SELECT state FROM e2ee_content_blobs WHERE project_id = ? AND blob_id = ?',
        projectId,
        blobId
      )
    ).toEqual([{ state: 'committed' }]);
  });

  it('refuses a viewer’s write at the Worker and in every browser', async () => {
    const { srv, laptop, member, projectId, document } = await shared('viewer');
    const opened = await member.store.loadProject(projectId);
    expect(opened.version).toBe(document.version);
    // The viewer's own browser does not send it.
    await refusedWith(
      member.store.saveProjectDocument({
        projectId,
        expectedVersion: opened.version,
        document: edited(opened, 'Viewer edit')
      }),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    await refusedWith(
      member.measurements.saveProjectMeasurements({
        projectId,
        expectedRevision: 0,
        record: {
          projectId,
          version: 1,
          updatedAt: '2026-10-24T01:00:00.000Z',
          display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
          measurements: []
        } as never
      }),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    // The Worker refuses one sent anyway (the role is mirrored as viewer).
    await laptop.store.loadProject(projectId);
    await catchUpProjectGroup(laptop.groups, projectId);
    const keys = await laptop.sessions.epochMaterial(ownerRef(projectId));
    await refusedWith(
      forgeVersion(srv, member, projectId, opened, keys),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    // Blob uploads and measurements too; the viewer's own view state is
    // its to keep, as in plaintext.
    for (const [method, path, body] of [
      ['POST', 'blobs/uploads', { blobId: 'a'.repeat(32), kind: 'import' }],
      ['PUT', 'measurements', {}]
    ] as const) {
      const response = await srv.call(
        method,
        `/api/e2ee/projects/${projectId}/${path}`,
        { user: OTHER, body }
      );
      expect(response.status, path).toBe(403);
    }
    expect(count(srv, 'e2ee_project_versions', projectId)).toBe(1);

    // A server that mirrors the viewer as an editor lets the write in;
    // every browser checks the author's role in its epoch and refuses it.
    memberRow(srv, projectId, OTHER, 'editor');
    await forgeVersion(srv, member, projectId, opened, keys);
    expect(head(srv, projectId).signer_user_id).toBe(OTHER);
    await integrityRefusal(
      ownerDesktop(srv).store.loadProject(projectId),
      'authority'
    );
    await integrityRefusal(
      device(srv, other, 'other_desktop', {
        members: [owner]
      }).store.loadProject(projectId),
      'authority'
    );
  });

  it('keeps verifying a demoted editor’s earlier versions', async () => {
    const { srv, laptop, member, projectId } = await shared('editor');
    const opened = await member.store.loadProject(projectId);
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Before demotion')
    });
    const written = head(srv, projectId);
    // The owner demotes the editor (slice 5-4 mirrors the row in the
    // Commit's batch; here by hand).
    await commitProjectGroup(laptop.groups, projectId, {
      setRoles: [{ userId: OTHER, role: 'viewer' }]
    });
    memberRow(srv, projectId, OTHER, 'viewer');
    // The editor's version, still the head, verifies by its own epoch.
    const desktop = ownerDesktop(srv);
    const read = await desktop.store.loadProject(projectId);
    expect(read.name).toBe('Before demotion');
    // Once caught up, the demoted member's browser no longer writes.
    await refusedWith(
      member.store.saveProjectDocument({
        projectId,
        expectedVersion: read.version,
        document: edited(read, 'After demotion')
      }),
      403,
      'E2EE_PROJECT_READ_ONLY'
    );
    // The owner writes on; a fresh browser checks the whole history,
    // the demoted editor's version in it.
    await laptop.store.saveProjectDocument({
      projectId,
      expectedVersion: read.version,
      document: edited(read, 'Owner after demotion')
    });
    forgetAllProjectKeys();
    const fresh = device(srv, owner, 'owner_desktop', { members: [other] });
    expect((await fresh.store.loadProject(projectId)).name).toBe(
      'Owner after demotion'
    );
    expect(
      rows<{ signer_user_id: string }>(
        srv,
        'SELECT signer_user_id FROM e2ee_project_versions WHERE project_id = ? AND document_version = ?',
        projectId,
        written.document_version
      )[0]!.signer_user_id
    ).toBe(OTHER);
  });

  it('refuses a removed member’s later version', async () => {
    const { srv, laptop, member, projectId } = await shared('editor');
    const opened = await member.store.loadProject(projectId);
    await member.store.saveProjectDocument({
      projectId,
      expectedVersion: opened.version,
      document: edited(opened, 'Before removal')
    });
    await commitProjectGroup(laptop.groups, projectId, {
      dropUsers: [OTHER]
    });
    const keys = await laptop.sessions.epochMaterial(ownerRef(projectId));
    // An honest server drops the row (slice 5-5) and refuses the member.
    srv.db
      .prepare(
        'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
      )
      .run(projectId, OTHER);
    await refusedWith(
      forgeVersion(srv, member, projectId, opened, keys),
      404,
      'PROJECT_NOT_FOUND'
    );
    // One that keeps it lets a version under the new epoch in; the roles
    // of that epoch no longer list the member, so every browser refuses it.
    memberRow(srv, projectId, OTHER, 'editor');
    const before = await ownerDesktop(srv).store.loadProject(projectId);
    expect(before.name).toBe('Before removal');
    forgetAllProjectKeys();
    await forgeVersion(srv, member, projectId, before, keys);
    await integrityRefusal(
      device(srv, owner, 'owner_desktop', {
        members: [other]
      }).store.loadProject(projectId),
      'authority'
    );
  });

  it('refuses an author the roles do not list at all', async () => {
    const { srv, laptop, projectId, document } = await shared('editor');
    await catchUpProjectGroup(laptop.groups, projectId);
    const keys = await laptop.sessions.epochMaterial(ownerRef(projectId));
    // The server makes THIRD an editor, and lists a leaf THIRD's device
    // certified; MLS never listed THIRD in the roles.
    memberRow(srv, projectId, THIRD, 'editor');
    const session = await inProcessMls().generate({
      projectId,
      userId: THIRD,
      deviceId: 'third_laptop'
    });
    const certification = await certifyLeaf(
      session,
      third.devices.get('third_laptop')!,
      0
    );
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_leaves
           (project_id, user_id, device_id, leaf_key, certification, created_at)
         VALUES (?, ?, 'third_laptop', ?, ?, '2026-10-24T00:00:00.000Z')`
      )
      .run(
        projectId,
        THIRD,
        toBase64Url(await session.signatureKey()),
        toBase64Url(certification)
      );
    const outsider = device(srv, third, 'third_laptop', {
      members: [owner, other]
    });
    await forgeVersion(srv, outsider, projectId, document, keys);
    expect(head(srv, projectId).signer_user_id).toBe(THIRD);
    // A browser that knows THIRD's list finds no role entry for them.
    await integrityRefusal(
      ownerDesktop(srv, [other, third]).store.loadProject(projectId),
      'authority'
    );
    // One that does not cannot even name the author.
    forgetAllProjectKeys();
    await integrityRefusal(
      ownerDesktop(srv).store.loadProject(projectId),
      'author'
    );
  });
});

describe('member key wraps and cutoffs (slice 5-2)', () => {
  it('serves and stores only the caller’s own wraps', async () => {
    const { srv, laptop, member, projectId } = await shared('viewer');
    await catchUpProjectGroup(laptop.groups, projectId);
    const ownerWraps = rows<{ wrapped: string }>(
      srv,
      'SELECT wrapped FROM e2ee_project_keys WHERE project_id = ? AND user_id = ?',
      projectId,
      OWNER
    ).map((row) => row.wrapped);
    expect(ownerWraps.length).toBeGreaterThan(0);
    const listed = await srv.call(
      'GET',
      `/api/e2ee/projects/${projectId}/keys`,
      { user: OTHER }
    );
    expect(listed.status).toBe(200);
    const text = await listed.text();
    for (const wrapped of ownerWraps) expect(text).not.toContain(wrapped);
    const { wraps } = JSON.parse(text) as {
      wraps: { keyEpoch: number; purpose: string }[];
    };
    // The viewer's own: epoch 1 it posted, epoch 2 its External Commit made.
    expect(wraps.map((w) => `${w.keyEpoch} ${w.purpose}`)).toEqual([
      '1 project-key',
      '1 rejoin-psk',
      '2 project-key',
      '2 rejoin-psk'
    ]);
    // They open under the viewer's own account key.
    forgetAllProjectKeys();
    const memberKey = await projectKeyForEpoch(member.groups, projectId, 1);
    forgetAllProjectKeys();
    expect(toHex(memberKey)).toBe(
      toHex(await projectKeyForEpoch(laptop.groups, projectId, 1))
    );

    const post = (user: string, body: Record<string, unknown>) =>
      srv.call('POST', `/api/e2ee/projects/${projectId}/keys`, { user, body });
    const stored = rows<{ purpose: string; wrapped: string }>(
      srv,
      `SELECT purpose, wrapped FROM e2ee_project_keys
       WHERE project_id = ? AND user_id = ? AND key_epoch = 1 ORDER BY purpose`,
      projectId,
      OTHER
    );
    const wrap = (purpose: string, keyEpoch: number, fill: string) => ({
      keyEpoch,
      purpose,
      accountKeyGeneration: 1,
      accountKeySequence: 0,
      wrapped: fill.repeat(55)
    });
    // A wrap already stored is kept.
    const again = await post(OTHER, {
      deviceId: 'other_laptop',
      keyEpoch: 1,
      wraps: [wrap('project-key', 1, 'C'), wrap('rejoin-psk', 1, 'C')]
    });
    expect(again.status).toBe(200);
    expect(
      ((await again.json()) as { wraps: { wrapped: string }[] }).wraps.map(
        (w) => w.wrapped
      )
    ).toEqual(stored.map((row) => row.wrapped));
    // Only for an epoch of the group, only by a member's certified device.
    const future = await post(OTHER, {
      deviceId: 'other_laptop',
      keyEpoch: 9,
      wraps: [wrap('project-key', 9, 'D'), wrap('rejoin-psk', 9, 'D')]
    });
    expect(future.status).toBe(409);
    expect(await future.json()).toMatchObject({ code: 'E2EE_EPOCH_UNKNOWN' });
    const foreignDevice = await post(OTHER, {
      deviceId: 'owner_laptop',
      keyEpoch: 2,
      wraps: [wrap('project-key', 2, 'E'), wrap('rejoin-psk', 2, 'E')]
    });
    expect(foreignDevice.status).toBe(403);
    const outsider = await post(THIRD, {
      deviceId: 'third_laptop',
      keyEpoch: 2,
      wraps: [wrap('project-key', 2, 'F'), wrap('rejoin-psk', 2, 'F')]
    });
    expect(outsider.status).toBe(404);
    expect(
      rows(
        srv,
        'SELECT 1 FROM e2ee_project_keys WHERE project_id = ? AND user_id = ?',
        projectId,
        THIRD
      )
    ).toEqual([]);
  });

  it('serves the other members’ cutoff statements to members only', async () => {
    const { srv, projectId } = await shared('viewer');
    const statement = (userId: string, sequence: number) =>
      srv.db
        .prepare(
          `INSERT INTO e2ee_revocation_cutoffs
             (user_id, generation, entry_sequence, entry_hash, statement,
              signature, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          userId,
          sequence,
          'a'.repeat(64),
          'AAAA',
          'B'.repeat(87),
          '2026-10-24T00:00:00.000Z',
          '2026-10-24T00:00:00.000Z'
        );
    statement(OWNER, 1);
    statement(OTHER, 1);
    statement(THIRD, 1);
    const path = `/api/e2ee/projects/${projectId}/revocation-cutoffs`;
    const asMember = await srv.call('GET', path, { user: OTHER });
    expect(asMember.status).toBe(200);
    const { statements } = (await asMember.json()) as {
      statements: { userId: string }[];
    };
    // The owner's; never the caller's own (its own route) or a stranger's.
    expect(statements.map((s) => s.userId)).toEqual([OWNER]);
    const asOwner = (await (await srv.call('GET', path)).json()) as {
      statements: { userId: string }[];
    };
    expect(asOwner.statements.map((s) => s.userId)).toEqual([OTHER]);
    expect((await srv.call('GET', path, { user: THIRD })).status).toBe(404);
  });
});
