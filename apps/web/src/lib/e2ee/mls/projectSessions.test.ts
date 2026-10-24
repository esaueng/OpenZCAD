// @vitest-environment node
// The committed MLS WASM is read from disk, which needs Node’s file URLs.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Mls } from '@openzcad/mls';
import { inProcessMls } from '../../../../../../packages/mls/src/test-support';
import {
  allowKeySession,
  beginKeySessionTeardown,
  getKeySessionRevision
} from '../keySession';
import type { DirectoryInput } from './directory';
import { createMlsLoader } from './loader';
import {
  MlsProjectSessions,
  MlsSessionMissing,
  type MlsProjectRef
} from './projectSessions';
import {
  memoryMlsSessionStore,
  MlsSessionConflict,
  type MlsSessionStore
} from './sessionStore';
import { device, testAccount, type TestAccount } from './testFixtures';

let alice: TestAccount;
let directory: DirectoryInput;
let projects = 0;

beforeAll(async () => {
  alice = await testAccount('user_alice', ['alice_laptop']);
  directory = { lists: [alice.list], certifications: [] };
});

afterEach(() => {
  // A teardown test leaves the page's key session blocked.
  allowKeySession(getKeySessionRevision());
});

const ref = (): MlsProjectRef => ({
  userId: alice.userId,
  deviceId: 'alice_laptop',
  projectId: `prj_sessions_${++projects}`
});

/** One tab: its own Worker (an in-process engine) over shared storage. */
function tab(store: MlsSessionStore): {
  sessions: MlsProjectSessions;
  started: Mls[];
} {
  const started: Mls[] = [];
  const sessions = new MlsProjectSessions(
    store,
    createMlsLoader(async () => {
      const mls = inProcessMls();
      started.push(mls);
      return mls;
    })
  );
  return { sessions, started };
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('MLS project sessions', () => {
  it('create a group, seal it and reopen it with the same project key', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const first = tab(store).sessions;
    const change = await first.createGroup(
      project,
      device(alice, 'alice_laptop'),
      directory
    );
    expect(change.epoch).toBe(0);
    const key = await first.projectKey(project);
    expect(key).toHaveLength(32);

    const stored = await store.loadSession(project.userId, project.projectId);
    expect(stored).toMatchObject({ revision: 1, pendingCommit: null });
    expect(hex(stored!.sealed.subarray(0, 4))).toBe('4f5a4d53'); // "OZMS"

    // A reload: a new page, a new Worker, the same IndexedDB.
    const reloaded = tab(store).sessions;
    expect(hex(await reloaded.projectKey(project))).toBe(hex(key));
    const status = await reloaded.status(project);
    expect(status).toMatchObject({ inGroup: true, epoch: 0, certified: true });
    expect(hex(status.signatureKey)).toBe(hex(stored!.leaf.signatureKey));

    // The sealed bytes open directly too, only under this account's key.
    const mls = inProcessMls();
    const stateKey = (await store.loadStateKey(project.userId))!;
    const opened = await mls.open(stored!.sealed, stateKey, project.projectId);
    expect(hex(await opened.projectKey())).toBe(hex(key));
    await expect(
      mls.open(stored!.sealed, stateKey, 'prj_elsewhere')
    ).rejects.toThrow('does not open');
  });

  it('refuse a second group for the project, or an operation with no state', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const { sessions } = tab(store);
    await expect(sessions.projectKey(project)).rejects.toBeInstanceOf(
      MlsSessionMissing
    );
    await sessions.createGroup(
      project,
      device(alice, 'alice_laptop'),
      directory
    );
    await expect(
      sessions.createGroup(project, device(alice, 'alice_laptop'), directory)
    ).rejects.toThrow('already has MLS state');
    // The refusal changed nothing stored.
    expect(
      (await store.loadSession(project.userId, project.projectId))?.revision
    ).toBe(1);
    await expect(
      sessions.projectKey({ ...project, deviceId: 'alice_other' })
    ).rejects.toThrow('another device');
  });

  it('re-read state another tab moved on', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const a = tab(store).sessions;
    const b = tab(store).sessions;
    await a.createGroup(project, device(alice, 'alice_laptop'), directory);
    const before = await a.projectKey(project);
    expect(hex(await b.projectKey(project))).toBe(hex(before));

    await b.commit(project, directory);
    const change = await b.confirmCommit(project, directory);
    expect(change.epoch).toBe(1);
    const after = await b.projectKey(project);
    expect(hex(after)).not.toBe(hex(before));
    expect(
      (await store.loadSession(project.userId, project.projectId))?.revision
    ).toBe(3);

    // Tab A still caches revision 1; it reopens the stored revision 3.
    expect(hex(await a.projectKey(project))).toBe(hex(after));
    expect((await a.status(project)).epoch).toBe(1);
  });

  it('refuse a stale revision when two tabs race without a lock, and the loser re-reads', async () => {
    const shared = memoryMlsSessionStore();
    // As if Web Locks did not coordinate the two: only compare-and-swap.
    const unlocked: MlsSessionStore = {
      ...shared,
      withProjectLock: (_userId, _projectId, run) => run()
    };
    const project = ref();
    const a = tab(unlocked).sessions;
    const b = tab(unlocked).sessions;
    await a.createGroup(project, device(alice, 'alice_laptop'), directory);
    await b.status(project); // both now hold revision 1 in memory

    const results = await Promise.allSettled([
      a.commit(project, directory),
      b.commit(project, directory)
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      MlsSessionConflict
    );
    const winner = (won[0] as PromiseFulfilledResult<{ commit: Uint8Array }>)
      .value;

    const stored = await shared.loadSession(project.userId, project.projectId);
    expect(stored?.revision).toBe(2);
    expect(hex(stored!.pendingCommit!.commit)).toBe(hex(winner.commit));

    // The loser's next operation reopens the winner's state, pending Commit
    // included, instead of forking from its own.
    const loser = results[0].status === 'rejected' ? a : b;
    expect((await loser.status(project)).pendingCommit).toBe(true);
    expect(hex((await loser.pendingCommit(project))!.commit)).toBe(
      hex(winner.commit)
    );
  });

  it('persist a pending Commit until it is confirmed', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const { sessions } = tab(store);
    await sessions.createGroup(
      project,
      device(alice, 'alice_laptop'),
      directory
    );
    const before = await sessions.projectKey(project);
    const pending = await sessions.commit(project, directory);
    expect(pending.welcome).toBeNull();
    await expect(sessions.commit(project, directory)).rejects.toThrow(
      'already pending'
    );

    // After a reload the Commit can be resent, then confirmed.
    const reloaded = tab(store).sessions;
    expect(hex((await reloaded.pendingCommit(project))!.commit)).toBe(
      hex(pending.commit)
    );
    expect((await reloaded.status(project)).pendingCommit).toBe(true);
    // Still the old epoch until the room accepts the Commit.
    expect(hex(await reloaded.projectKey(project))).toBe(hex(before));
    const change = await reloaded.confirmCommit(project, directory);
    expect(change.epoch).toBe(1);
    expect(await reloaded.pendingCommit(project)).toBeNull();
    const stored = await store.loadSession(project.userId, project.projectId);
    expect(stored).toMatchObject({ revision: 3, pendingCommit: null });
    expect(hex(await tab(store).sessions.projectKey(project))).toBe(
      hex(await reloaded.projectKey(project))
    );
  });

  it('persist a pending Commit until it is discarded', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const { sessions } = tab(store);
    await sessions.createGroup(
      project,
      device(alice, 'alice_laptop'),
      directory
    );
    const before = await sessions.projectKey(project);
    await sessions.commit(project, directory);

    const reloaded = tab(store).sessions;
    await reloaded.discardCommit(project);
    expect(await reloaded.pendingCommit(project)).toBeNull();
    const status = await reloaded.status(project);
    expect(status).toMatchObject({ epoch: 0, pendingCommit: false });
    expect(hex(await reloaded.projectKey(project))).toBe(hex(before));
    // The first tab re-reads the discard rather than keeping its pending state.
    expect((await sessions.status(project)).pendingCommit).toBe(false);
  });

  it('clear sessions, state keys and the Worker on key-session teardown', async () => {
    const store = memoryMlsSessionStore();
    const project = ref();
    const { sessions, started } = tab(store);
    await sessions.createGroup(
      project,
      device(alice, 'alice_laptop'),
      directory
    );
    await sessions.projectKey(project);
    expect(sessions.cachedSessions).toBe(1);
    const closed: Mls[] = [];
    for (const mls of started) {
      const close = mls.close.bind(mls);
      mls.close = () => {
        closed.push(mls);
        close();
      };
    }

    // An operation in flight when the session ends fails without writing.
    const inFlight = sessions.commit(project, directory);
    beginKeySessionTeardown();
    await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessions.cachedSessions).toBe(0);
    expect(closed).toEqual(started);
    expect(
      await store.loadSession(project.userId, project.projectId)
    ).toMatchObject({ revision: 1, pendingCommit: null });

    // Nothing runs while the key session is blocked.
    await expect(sessions.projectKey(project)).rejects.toMatchObject({
      name: 'AbortError'
    });

    // Once a session is ready again, the state reopens from storage in a
    // new Worker.
    allowKeySession(getKeySessionRevision());
    expect(await sessions.projectKey(project)).toHaveLength(32);
    expect(started).toHaveLength(2);
  });
});
