import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { E2eeStoredVersion, ProjectDocument } from '@openzcad/shared';
import { ApiError } from '../api';
import {
  E2EE_KEYS_LOCKED_CODE,
  EncryptedProjectIntegrityError,
  type EncryptedProjectStore,
  type EncryptedRoomAccess,
  type EncryptedRoomHeadState,
  type EncryptedRoomSealed
} from './encryptedProjectStore';
import {
  encryptionStatusOf,
  reportEncryptedFailure,
  reportHeadVerified,
  reportKeysLocked,
  reportKeysUnlocked,
  reportVerificationWarning,
  resetEncryptionStatus,
  retainEncryptionStatus,
  subscribeEncryptionStatus,
  useEncryptionStatus
} from './encryptionStatus';
import { reportingEncryptedProjectStore } from './encryptionStatusReports';
import {
  allowKeySession,
  beginKeySessionTeardown,
  blockKeySession,
  getKeySessionRevision
} from './keySession';

const STALE = {
  kind: 'stale-head',
  signedAt: 1_000,
  updatedAt: 1_000 + 60 * 60 * 1000
} as const;

const integrityError = () =>
  new EncryptedProjectIntegrityError(
    'rollback',
    'The account showed an older version than this browser already accepted.'
  );

const lockedError = () =>
  new ApiError(
    403,
    'Unlock encryption on this device (Settings › Encryption) to open or save encrypted projects.',
    E2EE_KEYS_LOCKED_CODE
  );

beforeEach(() => resetEncryptionStatus());

describe('encryption status store', () => {
  it('starts unverified and shows a verified head', () => {
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
    reportHeadVerified('proj_a');
    expect(encryptionStatusOf('proj_a')).toEqual({ state: 'verified' });
    expect(encryptionStatusOf('proj_b').state).toBe('unverified');
  });

  it('keeps a verification warning through the head that raised it and later heads', () => {
    // The store warns while reading the head, before it reports success.
    reportVerificationWarning('proj_a', STALE);
    reportHeadVerified('proj_a');
    expect(encryptionStatusOf('proj_a')).toEqual({
      state: 'warning',
      warning: STALE
    });
    reportHeadVerified('proj_a');
    expect(encryptionStatusOf('proj_a').state).toBe('warning');
    expect(encryptionStatusOf('proj_b').state).toBe('unverified');
  });

  it('marks an integrity failure as a problem, in its own words', () => {
    reportHeadVerified('proj_a');
    reportEncryptedFailure('proj_a', integrityError());
    expect(encryptionStatusOf('proj_a')).toEqual({
      state: 'problem',
      problem:
        'The account showed an older version than this browser already accepted.'
    });
    // A later head that verifies is the last outcome again.
    reportHeadVerified('proj_a');
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
  });

  it('ignores failures that say nothing about verification', () => {
    reportHeadVerified('proj_a');
    reportEncryptedFailure('proj_a', new ApiError(409, 'Conflict', 'VERSION'));
    reportEncryptedFailure('proj_a', new TypeError('Failed to fetch'));
    reportEncryptedFailure(null, integrityError());
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
  });

  it('shows locked keys for every encrypted project until a store opens', () => {
    reportHeadVerified('proj_a');
    reportEncryptedFailure(null, lockedError());
    expect(encryptionStatusOf('proj_a').state).toBe('locked');
    expect(encryptionStatusOf('proj_b').state).toBe('locked');
    reportKeysUnlocked();
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    reportKeysLocked();
    reportHeadVerified('proj_b');
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
  });

  it('keeps a problem ahead of locked keys', () => {
    reportEncryptedFailure('proj_a', integrityError());
    reportKeysLocked();
    expect(encryptionStatusOf('proj_a').state).toBe('problem');
  });

  it('forgets other projects when the open project changes', () => {
    reportHeadVerified('proj_a');
    reportVerificationWarning('proj_b', STALE);
    retainEncryptionStatus('proj_b');
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
    expect(encryptionStatusOf('proj_b').state).toBe('warning');
    retainEncryptionStatus(null);
    expect(encryptionStatusOf('proj_b').state).toBe('unverified');
  });

  it('forgets everything when the key session is torn down, not when it becomes ready', () => {
    reportVerificationWarning('proj_a', STALE);
    reportKeysLocked();
    reportEncryptedFailure('proj_b', integrityError());
    beginKeySessionTeardown();
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
    expect(encryptionStatusOf('proj_b').state).toBe('unverified');

    reportHeadVerified('proj_a');
    blockKeySession();
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
    reportHeadVerified('proj_a');
    expect(allowKeySession(getKeySessionRevision())).toBe(true);
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
  });

  it('notifies only on change and keeps snapshots stable', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEncryptionStatus(listener);
    reportHeadVerified('proj_a');
    const first = encryptionStatusOf('proj_a');
    reportHeadVerified('proj_a');
    reportKeysUnlocked();
    retainEncryptionStatus('proj_a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(encryptionStatusOf('proj_a')).toBe(first);
    unsubscribe();
    reportEncryptedFailure('proj_a', integrityError());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-renders a component reading the open project', () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string | null }) =>
        useEncryptionStatus(projectId),
      { initialProps: { projectId: null as string | null } }
    );
    expect(result.current.state).toBe('unverified');
    rerender({ projectId: 'proj_a' });
    expect(result.current.state).toBe('unverified');
    act(() => reportHeadVerified('proj_a'));
    expect(result.current.state).toBe('verified');
    act(() => reportKeysLocked());
    expect(result.current.state).toBe('locked');
    rerender({ projectId: null });
    expect(result.current.state).toBe('unverified');
  });
});

describe('encryption status reports from the encrypted store', () => {
  const document = { projectId: 'proj_a' } as unknown as ProjectDocument;
  const head = {} as EncryptedRoomHeadState;
  const sealed = {} as EncryptedRoomSealed;
  const record = {} as E2eeStoredVersion;

  function fakeStore(fail: Error | null = null) {
    const outcome = <T>(value: T) =>
      vi.fn(async () => {
        if (fail) throw fail;
        return value;
      });
    const room: EncryptedRoomAccess = {
      currentHead: vi.fn(() => head),
      seal: outcome(sealed),
      openHead: outcome(head),
      accepted: outcome(head),
      catchUp: outcome(undefined),
      restoreBlobs: outcome(undefined)
    };
    const created = { project: { projectId: 'proj_new' } };
    const store = {
      createProject: outcome(created),
      copyProject: outcome({ project: { projectId: 'proj_copy' } }),
      saveProjectDocument: outcome({ projectId: 'proj_a', version: 2 }),
      saveRevision: outcome(document),
      loadProject: outcome(document),
      loadRevision: outcome(document),
      listRevisions: outcome({ revisions: [], maxRevisions: 10 }),
      projectName: vi.fn(async () => 'Name'),
      info: {},
      replaced: {},
      roomAccess: () => room,
      stageMigratedProject: outcome({ project: { projectId: 'proj_staged' } }),
      revisionMap: outcome(new Map<string, string>()),
      forgetStagedProject: outcome(undefined)
    } as unknown as EncryptedProjectStore;
    return { store, room };
  }

  it('reports every head the page opens or writes as verified', async () => {
    const { store } = fakeStore();
    const reporting = reportingEncryptedProjectStore(store, () => true);
    await reporting.loadProject('proj_a');
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    await reporting.createProject({ name: 'New' });
    expect(encryptionStatusOf('proj_new').state).toBe('verified');
    await reporting.copyProject({
      sourceProjectId: 'proj_a',
      document
    });
    expect(encryptionStatusOf('proj_copy').state).toBe('verified');
    resetEncryptionStatus();
    await reporting.saveProjectDocument({
      projectId: 'proj_a',
      document,
      expectedVersion: 1
    } as never);
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    resetEncryptionStatus();
    await reporting.saveRevision({
      projectId: 'proj_a',
      document,
      reason: 'x',
      expectedVersion: 1
    } as never);
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    resetEncryptionStatus();
    await reporting.roomAccess().openHead('proj_a', record, null);
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    resetEncryptionStatus();
    await reporting.roomAccess().accepted('proj_a', sealed, head, record);
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    // A historical read verifies a revision, not the head.
    resetEncryptionStatus();
    await reporting.loadRevision('proj_a', 'rev_1');
    await reporting.listRevisions('proj_a');
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
  });

  it('reports an integrity failure from any path and rethrows it', async () => {
    const error = integrityError();
    const { store } = fakeStore(error);
    const reporting = reportingEncryptedProjectStore(store, () => true);
    await expect(reporting.loadProject('proj_a')).rejects.toBe(error);
    expect(encryptionStatusOf('proj_a').state).toBe('problem');
    await expect(
      reporting.roomAccess().openHead('proj_b', record, null)
    ).rejects.toBe(error);
    expect(encryptionStatusOf('proj_b').state).toBe('problem');
    await expect(reporting.loadRevision('proj_c', 'rev_1')).rejects.toBe(error);
    expect(encryptionStatusOf('proj_c').state).toBe('problem');
    // The room's blob repair (slice 5-6) goes through the same report.
    await expect(
      reporting.roomAccess().restoreBlobs('proj_d', ['blob_1'])
    ).rejects.toBe(error);
    expect(encryptionStatusOf('proj_d').state).toBe('problem');
  });

  it('reports what a migration stages and the journal it reads (slice 7-2)', async () => {
    const { store } = fakeStore();
    const reporting = reportingEncryptedProjectStore(store, () => true);
    await reporting.stageMigratedProject({
      document: { projectId: 'proj_staged' } as unknown as ProjectDocument,
      info: { name: 'Staged', exports: [] }
    });
    expect(encryptionStatusOf('proj_staged').state).toBe('verified');
    await reporting.revisionMap('proj_a');
    expect(encryptionStatusOf('proj_a').state).toBe('verified');
    // Forgetting a dropped staging reaches the store and verifies nothing.
    resetEncryptionStatus();
    await reporting.forgetStagedProject('proj_b');
    expect(store.forgetStagedProject).toHaveBeenCalledWith('proj_b');
    expect(encryptionStatusOf('proj_b').state).toBe('unverified');

    const error = integrityError();
    const failing = reportingEncryptedProjectStore(
      fakeStore(error).store,
      () => true
    );
    await expect(
      failing.stageMigratedProject({
        document: { projectId: 'proj_c' } as unknown as ProjectDocument,
        info: { name: 'Staged', exports: [] }
      })
    ).rejects.toBe(error);
    expect(encryptionStatusOf('proj_c').state).toBe('problem');
    await expect(failing.revisionMap('proj_d')).rejects.toBe(error);
    expect(encryptionStatusOf('proj_d').state).toBe('problem');
  });

  it('reports nothing once the key session that opened the store ended', async () => {
    const { store } = fakeStore();
    let current = true;
    const reporting = reportingEncryptedProjectStore(store, () => current);
    const load = reporting.loadProject('proj_a');
    current = false;
    await load;
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
    const failing = reportingEncryptedProjectStore(
      fakeStore(integrityError()).store,
      () => false
    );
    await expect(failing.loadProject('proj_a')).rejects.toBeInstanceOf(
      EncryptedProjectIntegrityError
    );
    expect(encryptionStatusOf('proj_a').state).toBe('unverified');
  });

  it('classifies a locked key session as locked', () => {
    reportEncryptedFailure(null, lockedError());
    expect(encryptionStatusOf('proj_a').state).toBe('locked');
  });
});
