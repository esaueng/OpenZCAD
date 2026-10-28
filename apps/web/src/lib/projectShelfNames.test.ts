import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSummary } from '@openzcad/shared';
import { OrganizationMirrorBackground } from './projectOrganizationBackground';
import {
  allowKeySession,
  blockKeySession,
  getKeySessionRevision
} from './e2ee/keySession';
import {
  cachedShelfNames,
  forgetShelfNames,
  forgetShelfProjectNames,
  rememberVerifiedShelfName,
  SHELF_NAMES_PREFIX,
  withCachedShelfNames
} from './projectShelfNames';

const project = {
  projectId: 'proj_name_hint',
  name: 'Verified bracket',
  updatedAt: '2026-10-28T12:00:00Z',
  storageFormat: 2,
  documentVersion: 7,
  revisionCount: 2
} as ProjectSummary;
const pending = new Set([project.projectId]);
const storageKey = SHELF_NAMES_PREFIX + 'account-a';
beforeEach(() => {
  vi.useFakeTimers();
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => saved.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      saved.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      saved.delete(key);
    })
  });
  blockKeySession();
  allowKeySession(getKeySessionRevision());
});
afterEach(() => {
  forgetShelfNames('account-a');
  forgetShelfNames('account-b');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('verified shelf name hints', () => {
  it('does not let an older same-account listing purge titles learned by a newer discovery', () => {
    const background = new OrganizationMirrorBackground({
      storage: localStorage,
      locks: null
    });
    const oldScope = background.begin('account-a');
    rememberVerifiedShelfName('account-a', project);
    const oldHints = cachedShelfNames('account-a');
    const oldListingIds = new Set([project.projectId]);
    const newScope = background.begin('account-a');
    const added = {
      ...project,
      projectId: 'proj_newly_shared',
      name: 'New shared bracket'
    } as ProjectSummary;
    rememberVerifiedShelfName('account-a', added);
    expect(oldScope.ownsDiscovery()).toBe(false);
    // The old response resumes with the same key revision and a live reference
    // to the shared cache, which now includes the newly verified project.
    forgetShelfProjectNames(
      'account-a',
      [...oldHints.keys()].filter((id) => !oldListingIds.has(id)),
      oldScope.ownsDiscovery
    );
    vi.advanceTimersByTime(100);
    expect(cachedShelfNames('account-a').get(added.projectId)?.name).toBe(
      added.name
    );
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toContainEqual([
      added.projectId,
      added.name,
      added.updatedAt
    ]);
    forgetShelfProjectNames(
      'account-a',
      [project.projectId],
      newScope.ownsDiscovery
    );
    expect(cachedShelfNames('account-a').has(project.projectId)).toBe(false);
    expect(cachedShelfNames('account-a').has(added.projectId)).toBe(true);
  });
  it('forgets purged names without discarding other cached titles or allowing a queued write to restore them', () => {
    rememberVerifiedShelfName('account-a', project);
    rememberVerifiedShelfName('account-a', {
      ...project,
      projectId: 'proj_kept'
    } as ProjectSummary);
    forgetShelfProjectNames('account-a', [project.projectId]);
    vi.advanceTimersByTime(100);
    expect(cachedShelfNames('account-a').has(project.projectId)).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([
      ['proj_kept', project.name, project.updatedAt]
    ]);
  });
  it('makes a verified title available immediately and batches only device presentation fields to disk', () => {
    const writes = vi.mocked(localStorage.setItem);
    rememberVerifiedShelfName('account-a', project);
    rememberVerifiedShelfName('account-a', {
      ...project,
      name: 'Latest verified bracket'
    });
    expect(cachedShelfNames('account-a').get(project.projectId)?.name).toBe(
      'Latest verified bracket'
    );
    expect(writes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([
      [project.projectId, 'Latest verified bracket', project.updatedAt]
    ]);
  });

  it('restores cloud-only names before any new verification and never changes versions or access', () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify([[project.projectId, project.name, project.updatedAt]])
    );
    const listed = {
      ...project,
      name: 'Encrypted project',
      updatedAt: '2026-10-29T12:00:00Z'
    };
    expect(
      withCachedShelfNames([listed], cachedShelfNames('account-a'), pending, [])
    ).toEqual([{ ...listed, name: project.name }]);
    expect(
      withCachedShelfNames(
        [listed],
        cachedShelfNames('account-a'),
        new Set(),
        []
      )[0]
    ).toBe(listed);
  });

  it('preserves a newer device rename and accepts a new verified title', () => {
    rememberVerifiedShelfName('account-a', project);
    const newer = {
      ...project,
      name: 'New device rename',
      updatedAt: '2026-10-29T12:00:00Z'
    };
    expect(
      withCachedShelfNames([newer], cachedShelfNames('account-a'), pending, [
        newer
      ])[0]
    ).toBe(newer);
    const verified = { ...newer, name: 'Latest verified name' };
    expect(
      withCachedShelfNames(
        [verified],
        cachedShelfNames('account-a'),
        undefined,
        []
      )[0]
    ).toBe(verified);
    rememberVerifiedShelfName('account-a', verified);
    rememberVerifiedShelfName('account-a', project);
    expect(cachedShelfNames('account-a').get(project.projectId)?.name).toBe(
      verified.name
    );
  });

  it('does not carry names into another account or a blocked key session, including queued writes', () => {
    rememberVerifiedShelfName('account-a', project);
    blockKeySession();
    vi.advanceTimersByTime(100);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(cachedShelfNames('account-a').size).toBe(0);
    rememberVerifiedShelfName('account-a', project);
    expect(cachedShelfNames(null).size).toBe(0);
    allowKeySession(getKeySessionRevision());
    expect(cachedShelfNames('account-b').size).toBe(0);
  });

  it('ignores malformed data and unavailable storage without holding up the library', () => {
    localStorage.setItem(
      storageKey,
      '[null, [12,"wrong id","bad"], ["id","","bad"], ["ok","Good","2026-10-28"]]'
    );
    expect([...cachedShelfNames('account-a').keys()]).toEqual(['ok']);
    blockKeySession();
    allowKeySession(getKeySessionRevision());
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(cachedShelfNames('account-a').size).toBe(0);
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new Error('quota');
    });
    rememberVerifiedShelfName('account-a', project);
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });

  it('forgets the device cache at sign-out and cancels pending writes', () => {
    rememberVerifiedShelfName('account-a', project);
    vi.advanceTimersByTime(100);
    rememberVerifiedShelfName('account-a', {
      ...project,
      name: 'Queued title'
    });
    forgetShelfNames('account-a');
    vi.advanceTimersByTime(100);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(cachedShelfNames('account-a').size).toBe(0);
  });
});
