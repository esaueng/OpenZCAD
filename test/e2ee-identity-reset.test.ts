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
import {
  AUTHORITY_WITHDRAWN_PROBLEM,
  IDENTITY_DISCONTINUED_PROBLEM
} from '../apps/web/src/lib/e2ee/encryptionStatus';
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

it('keeps a withdrawal refusal, not the reset one, when the identity is unchanged or was rotated with a transition', async () => {
  const { srv, desktop, projectId } = await pinnedProject();
  srv.db
    .prepare('DELETE FROM e2ee_project_authority WHERE project_id = ?')
    .run(projectId);
  // Same identity: a withdrawal, not a reset. The owner's confirmed
  // restoration is its way forward (`e2ee-authority-restore.test.ts`).
  const same = await loadProjectAuthority(desktop.groups, projectId).catch(
    (error: unknown) => error
  );
  expect(same).toMatchObject({
    code: 'authority-withdrawn',
    message: AUTHORITY_WITHDRAWN_PROBLEM
  });

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

/**
 * Runs `hook` once, as a concurrent request would, immediately before or
 * after the statement that installs the erasure fence: the statement the
 * acknowledgement must be decided in. The rest of the erasure, and the
 * hook's own requests, go to the real database unchanged.
 */
function aroundFence(
  srv: Server,
  when: 'before' | 'after',
  hook: () => Promise<void>
): D1Database {
  const db = srv.env.DB as D1Database;
  let pending = true;
  const fenced = (sql: string) =>
    pending && /INSERT INTO account_erasure_requests\b/.test(sql);
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'prepare')
        return Reflect.get(target, key, receiver) as unknown;
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!fenced(sql)) return statement;
        const run =
          (bound: D1PreparedStatement) =>
          async <T>(): Promise<T | null> => {
            pending = false;
            if (when === 'before') await hook();
            const result = await bound.first<T>();
            if (when === 'after') await hook();
            return result;
          };
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return { ...bound, bind: bound.bind, first: run(bound) };
          }
        };
      };
    }
  });
}
const ownedEncrypted = (srv: Server) =>
  rows<{ n: number }>(
    srv,
    'SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND storage_format = 2',
    OWNER
  )[0]!.n;

it('refuses, with nothing deleted, when a project is encrypted just before the fence lands', async () => {
  const srv = newServer([before]);
  const desktop = device(srv, before, 'owner_desktop');
  // The preview said none; the old pre-check saw none too, then the
  // concurrent create committed before the fence and was stranded.
  const db = aroundFence(srv, 'before', async () => {
    await createEncrypted(desktop, 'Concurrent');
  });
  await expect(
    deleteAccountData(
      session,
      {
        scope: 'profile',
        confirmation: 'DELETE CLOUD PROFILE',
        acknowledgedEncryptedProjectCount: 0
      },
      { ...srv.env, DB: db },
      { deleteOwnedProjects: async () => [] } as never
    )
  ).rejects.toMatchObject({
    status: 409,
    code: 'ACCOUNT_DELETION_ENCRYPTED_PROJECTS'
  });
  expect(ownedEncrypted(srv)).toBe(1);
  // No fence left behind, and every key still opens the project.
  expect(
    rows(srv, 'SELECT 1 FROM account_erasure_requests WHERE user_id = ?', OWNER)
  ).toHaveLength(0);
  expect(
    rows(srv, 'SELECT 1 FROM e2ee_identities WHERE user_id = ?', OWNER)
  ).toHaveLength(1);
  expect(
    rows(srv, 'SELECT 1 FROM e2ee_project_authority WHERE user_id = ?', OWNER)
  ).toHaveLength(1);
  // A retry acknowledging it is the supported explicit deletion.
  expect((await eraseProfile(srv, 1)).scope).toBe('profile');
});

it('refuses the concurrent encryption instead once the fence has landed', async () => {
  const srv = newServer([before]);
  const desktop = device(srv, before, 'owner_desktop');
  let refused: unknown = null;
  const db = aroundFence(srv, 'after', async () => {
    refused = await createEncrypted(desktop, 'Concurrent').then(
      () => null,
      (error: unknown) => error
    );
  });
  expect(
    (
      await deleteAccountData(
        session,
        {
          scope: 'profile',
          confirmation: 'DELETE CLOUD PROFILE',
          acknowledgedEncryptedProjectCount: 0
        },
        { ...srv.env, DB: db },
        { deleteOwnedProjects: async () => [] } as never
      )
    ).scope
  ).toBe('profile');
  expect(refused).not.toBeNull();
  // Nothing encrypted was left behind for the erased keys.
  expect(ownedEncrypted(srv)).toBe(0);
  expect(
    rows(
      srv,
      'SELECT 1 FROM e2ee_project_groups WHERE project_id IN (SELECT id FROM projects WHERE user_id = ?)',
      OWNER
    )
  ).toHaveLength(0);
});
