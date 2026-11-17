/**
 * Issue #1704: encrypted projects an account still owns after its profile
 * was deleted, and encryption was set up again, under the same stable user
 * id. The deletion erases the identity and every per-account record that
 * opens those projects (authority, wraps, leaves) but keeps the projects;
 * a fresh setup then starts an unrelated generation 1. A browser that
 * pinned the erased identity correctly refuses the projects; these tests
 * pin that the deletion now needs the stranding acknowledged, and that the
 * refusal names the cause and the way forward without weakening anything.
 */
import { beforeAll, expect, it } from 'vitest';
import { fromBase64Url, toHex } from '@openzcad/crypto';
import { deleteAccountData } from '../apps/web/worker/accountDeletion';
import {
  loadProjectAuthority,
  ProjectAuthorityError
} from '../apps/web/src/lib/e2ee/projectAuthority';
import { IDENTITY_DISCONTINUED_PROBLEM } from '../apps/web/src/lib/e2ee/encryptionStatus';
import {
  epochAuthority,
  ProjectGroupError
} from '../apps/web/src/lib/e2ee/projectGroups';
import { EncryptedProjectIntegrityError } from '../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  createEncrypted,
  device,
  makeAccount,
  newServer,
  OWNER,
  rows,
  type Account,
  type Server
} from './support/e2ee-documents';

let before: Account;
beforeAll(async () => {
  before = await makeAccount(OWNER, ['owner_laptop', 'owner_desktop']);
});

const session = {
  userId: OWNER as never,
  displayName: 'Owner',
  mode: 'development' as const
};
const eraseProfile = (srv: Server, acknowledged?: number) =>
  deleteAccountData(
    session,
    {
      scope: 'profile',
      confirmation: 'DELETE CLOUD PROFILE',
      ...(acknowledged === undefined
        ? {}
        : { acknowledgedEncryptedProjectCount: acknowledged })
    },
    srv.env,
    { deleteOwnedProjects: async () => [] } as never
  );
const authorityRows = (srv: Server, projectId: string) =>
  rows(
    srv,
    'SELECT 1 FROM e2ee_project_authority WHERE user_id = ? AND project_id = ?',
    OWNER,
    projectId
  ).length;

/** An owned encrypted project another browser of the account pinned. */
async function pinnedProject() {
  const srv = newServer([before]);
  // The browser that keeps its pins wrote the project, as on the beta.
  const desktop = device(srv, before, 'owner_desktop');
  const { document } = await createEncrypted(desktop);
  const projectId = document.projectId;
  await loadProjectAuthority(desktop.groups, projectId);
  const pinned = await desktop.groups.authorityStore!.read(OWNER, projectId);
  expect(pinned.accepted).not.toBeNull();
  expect(pinned.owner?.identityKeyHash).toBe(
    toHex(before.list.identityKeyHash)
  );
  return { srv, desktop, projectId, pinned };
}

it('previews and refuses a profile deletion that would strand unacknowledged encrypted projects', async () => {
  const { srv, projectId } = await pinnedProject();
  const { accountDeletionPreview } =
    await import('../apps/web/worker/accountDeletion');
  const preview = await accountDeletionPreview(session, 'profile', srv.env, {
    getStorageUsage: async () => ({
      projectCount: 1,
      documentBytes: 0,
      revisionBytes: 0,
      revisionCount: 0
    })
  } as never);
  expect(preview.encryptedProjectCount).toBe(1);
  for (const acknowledged of [undefined, 0]) {
    await expect(eraseProfile(srv, acknowledged)).rejects.toMatchObject({
      status: 409,
      code: 'ACCOUNT_DELETION_ENCRYPTED_PROJECTS'
    });
  }
  // Refused before any fence or deletion: keys and authority remain.
  expect(authorityRows(srv, projectId)).toBe(1);
  expect(
    rows(srv, 'SELECT 1 FROM e2ee_identities WHERE user_id = ?', OWNER)
  ).toHaveLength(1);
  expect(
    rows(srv, 'SELECT 1 FROM account_erasure_requests WHERE user_id = ?', OWNER)
  ).toHaveLength(0);
});

it('reproduces the stranded lifecycle and refuses it with a recovery-specific, pin-preserving error', async () => {
  const { srv, desktop, projectId, pinned } = await pinnedProject();
  // Acknowledged: the supported profile deletion still runs.
  expect((await eraseProfile(srv, 1)).scope).toBe('profile');
  // The deployed state: project and group kept, every key and the
  // account's authority record erased.
  expect(
    rows(srv, 'SELECT 1 FROM projects WHERE id = ?', projectId)
  ).toHaveLength(1);
  expect(
    rows(
      srv,
      'SELECT 1 FROM e2ee_project_groups WHERE project_id = ?',
      projectId
    )
  ).toHaveLength(1);
  expect(authorityRows(srv, projectId)).toBe(0);
  const erased = (await (
    await srv.call('GET', '/api/e2ee/account')
  ).json()) as { current: unknown; previous: unknown[] };
  expect(erased).toEqual({ current: null, previous: [] });

  // Signing in again reaches the same user id; a fresh setup is a new,
  // unrelated generation 1 that names no identity it replaces. The other
  // browser kept its device keys and is certified again under it.
  const after = await makeAccount(OWNER, ['owner_desktop'], [], {
    reuse: before.signingPairs
  });
  after.seed(srv.db);
  const account = (await (
    await srv.call('GET', '/api/e2ee/account')
  ).json()) as {
    current: { generation: number; identityKey: string };
    previous: unknown[];
  };
  expect(account.current.generation).toBe(1);
  expect(account.previous).toEqual([]);
  expect(after.list.identityKey).not.toEqual(before.list.identityKey);
  expect(fromBase64Url(account.current.identityKey)).toEqual(
    after.list.identityKey
  );

  // The other browser, re-certified under the new identity, keeps its pins.
  const browser = device(srv, after, 'owner_desktop', {
    authority: desktop.groups.authorityStore,
    mls: desktop.mls,
    pins: desktop.pins
  });
  const refusal = await loadProjectAuthority(browser.groups, projectId).catch(
    (error: unknown) => error
  );
  expect(refusal).toBeInstanceOf(ProjectAuthorityError);
  expect(refusal).toMatchObject({
    code: 'identity-discontinued',
    message: IDENTITY_DISCONTINUED_PROBLEM
  });
  // Membership verification surfaces it unwrapped, still as a refusal.
  const historical = await epochAuthority(browser.groups, projectId, 0).catch(
    (error: unknown) => error
  );
  expect(historical).toBeInstanceOf(ProjectGroupError);
  expect(historical).toMatchObject({
    code: 'archive-invalid',
    detail: 'identity-discontinued',
    message: IDENTITY_DISCONTINUED_PROBLEM
  });
  const opened = await browser.store
    .loadProject(projectId)
    .catch((error: unknown) => error);
  expect(opened).toBeInstanceOf(EncryptedProjectIntegrityError);
  expect(opened).toMatchObject({
    reason: 'authority',
    message: IDENTITY_DISCONTINUED_PROBLEM
  });
  // Fail closed: nothing adopted, nothing forgotten, nothing written.
  expect(await desktop.groups.authorityStore!.read(OWNER, projectId)).toEqual(
    pinned
  );
  expect(authorityRows(srv, projectId)).toBe(0);
});

it('keeps the generic withdrawal refusal when the identity is unchanged or was rotated with a transition', async () => {
  const { srv, desktop, projectId } = await pinnedProject();
  srv.db
    .prepare('DELETE FROM e2ee_project_authority WHERE project_id = ?')
    .run(projectId);
  // Same identity: a withdrawal, not a reset.
  const same = await loadProjectAuthority(desktop.groups, projectId).catch(
    (error: unknown) => error
  );
  expect(same).toMatchObject({ code: 'invalid' });
  expect((same as Error).message).toMatch(/withdrew/);

  // A different identity whose genesis names the one it replaces is a
  // rotation: authority missing there is not explained away as a reset.
  const rotated = await makeAccount(OWNER, ['owner_desktop']);
  const [first, ...rest] = rotated.list.entries;
  const groups = {
    ...desktop.groups,
    account: {
      ...desktop.groups.account,
      list: {
        ...rotated.list,
        entries: [
          {
            ...first!,
            entry: {
              ...first!.entry,
              previousIdentityKeyHash: before.list.identityKeyHash
            }
          },
          ...rest
        ]
      }
    }
  };
  const refusal = await loadProjectAuthority(groups, projectId).catch(
    (error: unknown) => error
  );
  expect(refusal).toMatchObject({ code: 'invalid' });
  expect((refusal as Error).message).toMatch(/withdrew/);
});
