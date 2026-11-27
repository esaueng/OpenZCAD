import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_ORGANIZATION,
  toProjectId,
  type ProjectSummary
} from '@openzcad/shared';
import {
  createProjectCopyLandings,
  withLandedCloudCopies,
  withLandedCopies,
  type ShelfChange
} from './projectCopyLandings';

const row = (projectId: string, name = projectId): ProjectSummary => ({
  projectId: toProjectId(projectId),
  name,
  revisionCount: 1,
  updatedAt: '2026-11-26T10:00:00.000Z'
});

const trashedRow = (projectId: string): ProjectSummary => ({
  ...row(projectId),
  organization: {
    ...DEFAULT_PROJECT_ORGANIZATION,
    status: 'deleted',
    deletedAt: '2026-11-26T10:01:00.000Z'
  }
});

const ids = (projects: readonly ProjectSummary[]) =>
  projects.map((project) => project.projectId);

const projectIds = (changes: readonly ShelfChange[] | null) =>
  changes?.map((change) => change.projectId) ?? null;

describe('createProjectCopyLandings', () => {
  it('keeps for a listing only the copies that landed after it began', () => {
    const landings = createProjectCopyLandings();
    const before = landings.beginListing('acct');
    landings.land('acct', 'early', false);
    const listing = landings.beginListing('acct');
    landings.land('acct', 'late', true);
    landings.listingReturned(listing);
    expect(projectIds(landings.takeLandedSince(listing, 'acct'))).toEqual([
      'late'
    ]);
    expect(projectIds(landings.takeLandedSince(before, 'acct'))).toEqual([
      'early',
      'late'
    ]);
  });

  it('gives the same copies when a result is read twice as it is applied', () => {
    const landings = createProjectCopyLandings();
    const listing = landings.beginListing(null);
    landings.land(null, 'copy', false);
    expect(landings.takeLandedSince(listing, null)).toHaveLength(1);
    expect(landings.takeLandedSince(listing, null)).toHaveLength(1);
  });

  it('never hands one account’s copies to another account’s listing', () => {
    const landings = createProjectCopyLandings();
    const signedOut = landings.beginListing(null);
    const other = landings.beginListing('other');
    const own = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    expect(landings.takeLandedSince(signedOut, null)).toEqual([]);
    expect(landings.takeLandedSince(other, 'other')).toEqual([]);
    expect(landings.takeLandedSince(own, 'acct')).toHaveLength(1);
  });

  it('refuses a listing for an account no longer signed in, or before one signed in', () => {
    const landings = createProjectCopyLandings();
    // Back to projects while signed in, then a sign-out before it returns.
    const beforeSignOut = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    expect(landings.takeLandedSince(beforeSignOut, null)).toBeNull();
    // Listed signed out, then a sign-in; or listed for another account.
    expect(
      landings.takeLandedSince(landings.beginListing(null), 'acct')
    ).toBeNull();
    expect(
      landings.takeLandedSince(landings.beginListing('other'), 'acct')
    ).toBeNull();
    // Sign-in's and sign-out's own listings are for the account they set.
    expect(
      landings.takeLandedSince(landings.beginListing('acct'), 'acct')
    ).toEqual([]);
    expect(landings.takeLandedSince(landings.beginListing(null), null)).toEqual(
      []
    );
  });

  it('hands a device-only copy to any account’s listing, as every listing lists this device', () => {
    const landings = createProjectCopyLandings();
    // Signed out as the copy began; the sign-in listing read this device
    // before the copy was written.
    const signIn = landings.beginListing('acct');
    const signOut = landings.beginListing(null);
    landings.land(null, 'device-copy', false);
    landings.land('acct', 'signed-in-device-copy', false);
    expect(projectIds(landings.takeLandedSince(signIn, 'acct'))).toEqual([
      'device-copy',
      'signed-in-device-copy'
    ]);
    expect(projectIds(landings.takeLandedSince(signOut, null))).toEqual([
      'device-copy',
      'signed-in-device-copy'
    ]);
  });

  it('records nothing while no listing could have missed the change', () => {
    const landings = createProjectCopyLandings();
    landings.land('acct', 'copy', true);
    landings.remove(['gone'], true);
    landings.edit(['moved']);
    expect(landings.size).toBe(0);
    expect(
      landings.takeLandedSince(landings.beginListing('acct'), 'acct')
    ).toEqual([]);
  });

  it('drops a record once no listing that began before it is out', () => {
    const landings = createProjectCopyLandings();
    const first = landings.beginListing('acct');
    landings.land('acct', 'a', false);
    const second = landings.beginListing('acct');
    landings.land('acct', 'b', false);
    expect(landings.size).toBe(2);
    landings.takeLandedSince(first, 'acct');
    // `a` landed before `second` began, so only `first` needed it.
    landings.beginListing('acct');
    expect(landings.size).toBe(1);
    landings.takeLandedSince(second, 'acct');
    landings.land('acct', 'c', false);
    // The third listing is still out, so only `c` (after it began) is held.
    expect(landings.size).toBe(1);
  });

  it('ends a listing refused for its account like one applied', () => {
    const landings = createProjectCopyLandings();
    const refused = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    expect(landings.takeLandedSince(refused, null)).toBeNull();
    landings.beginListing(null);
    expect(landings.size).toBe(0);
  });

  it('stops holding a returned listing never applied after a short bound', () => {
    let now = 0;
    const landings = createProjectCopyLandings({
      now: () => now,
      unappliedListingMs: 1_000
    });
    const abandoned = landings.beginListing('acct');
    landings.land('acct', 'copy', false);
    landings.listingReturned(abandoned);
    now = 999;
    landings.land('acct', 'kept-alive-check', false);
    expect(landings.size).toBe(2);
    now = 1_000;
    landings.beginListing('acct');
    expect(landings.size).toBe(0);
  });

  it('caps how long a record lives behind a listing that never returns', () => {
    let now = 0;
    const landings = createProjectCopyLandings({
      now: () => now,
      recordMs: 5_000
    });
    const stalled = landings.beginListing('acct');
    landings.land('acct', 'copy', false);
    now = 5_000;
    landings.beginListing('acct');
    expect(landings.size).toBe(0);
    expect(landings.takeLandedSince(stalled, 'acct')).toEqual([]);
  });

  it('hands a listing the deletions and shelf edits made after it began, for any account', () => {
    const landings = createProjectCopyLandings();
    landings.beginListing('acct');
    landings.remove(['early'], true);
    const listing = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    landings.edit(['copy']);
    landings.remove(['copy'], true);
    landings.remove(['erased'], false);
    expect(
      landings
        .takeLandedSince(listing, 'acct')!
        .map((change) => `${change.kind}:${change.projectId}`)
    ).toEqual(['landed:copy', 'edited:copy', 'removed:copy', 'removed:erased']);
  });
});

describe('withLandedCopies', () => {
  let sequence = 0;
  const landed = (projectId: string, inAccount = false): ShelfChange => ({
    kind: 'landed',
    sequence: ++sequence,
    accountId: 'acct',
    projectId,
    inAccount,
    at: 0
  });
  const removed = (projectId: string, fromDevice = true): ShelfChange => ({
    kind: 'removed',
    sequence: ++sequence,
    projectId,
    fromDevice,
    at: 0
  });
  const edited = (projectId: string): ShelfChange => ({
    kind: 'edited',
    sequence: ++sequence,
    projectId,
    at: 0
  });

  it('adds a landed copy the listing missed, taking its row from the shelf', () => {
    const listed = [row('listed')];
    const current = [row('listed'), row('copy', 'Part (copy)')];
    expect(ids(withLandedCopies(listed, current, [landed('copy')]))).toEqual(
      ids([row('copy'), row('listed')]).sort()
    );
  });

  it('keeps every landed copy once, also when the listing already has it', () => {
    const listed = [row('a', 'A (listed)'), row('other')];
    const current = [row('a', 'A (shelf)'), row('b'), row('other')];
    const kept = withLandedCopies(listed, current, [
      landed('a'),
      landed('b'),
      landed('b')
    ]);
    expect(ids(kept).sort()).toEqual(['a', 'b', 'other']);
    expect(kept.find((project) => project.projectId === 'a')?.name).toBe(
      'A (listed)'
    );
  });

  it('carries what the user did to the copy since, and never revives one removed', () => {
    const trashed = trashedRow('copy');
    expect(
      withLandedCopies([row('listed')], [trashed], [landed('copy')]).find(
        (project) => project.projectId === 'copy'
      )
    ).toBe(trashed);
    expect(
      ids(withLandedCopies([row('listed')], [row('listed')], [landed('copy')]))
    ).toEqual(['listed']);
  });

  it('drops a copy destroyed after the listing read it', () => {
    // The listing read the copy once it had landed; the user then trashed it
    // and deleted it forever before the listing was applied.
    const listed = [row('listed'), row('copy')];
    expect(
      ids(
        withLandedCopies(
          listed,
          [row('listed')],
          [landed('copy'), edited('copy'), removed('copy')]
        )
      )
    ).toEqual(['listed']);
    expect(
      ids(withLandedCopies(listed, [row('listed')], [removed('copy')]))
    ).toEqual(['listed']);
  });

  it('keeps a destroyed project the shelf has again (a sample reset and rebuilt)', () => {
    const rebuilt = row('sample', 'Sample (original)');
    expect(
      withLandedCopies(
        [row('sample', 'Sample (edited)')],
        [rebuilt],
        [removed('sample')]
      )
    ).toEqual([rebuilt]);
    expect(withLandedCopies([], [rebuilt], [removed('sample')])).toEqual([
      rebuilt
    ]);
  });

  it('keeps the device row of a project deleted from the account only', () => {
    const listed = [row('erased')];
    expect(withLandedCopies(listed, [], [removed('erased', false)])).toBe(
      listed
    );
  });

  it('keeps a trash, restore or archive made after the listing read the shelf', () => {
    const listed = [row('a', 'A (listed name)'), row('b')];
    const kept = withLandedCopies(
      listed,
      [trashedRow('a'), row('b')],
      [edited('a')]
    );
    const a = kept.find((project) => project.projectId === 'a');
    expect(a?.organization?.status).toBe('deleted');
    // Only the shelf state is the shelf's; the rest is the listing's.
    expect(a?.name).toBe('A (listed name)');
    // A restore wins the same way over a listing that read it in the trash.
    const restored: ProjectSummary = {
      ...row('a'),
      organization: DEFAULT_PROJECT_ORGANIZATION
    };
    expect(
      withLandedCopies([trashedRow('a')], [restored], [edited('a')])[0]
        ?.organization?.status
    ).toBe('active');
  });

  it('does not bring back an edited project the listing no longer has', () => {
    const listed = [row('listed')];
    expect(
      withLandedCopies(
        listed,
        [row('listed'), trashedRow('gone')],
        [edited('gone')]
      )
    ).toBe(listed);
  });

  it('returns the listing itself when nothing is added', () => {
    const listed = [row('listed')];
    expect(withLandedCopies(listed, [], [])).toBe(listed);
    expect(withLandedCopies(listed, listed, [landed('listed')])).toBe(listed);
  });
});

describe('withLandedCloudCopies', () => {
  const change = (
    sequence: number,
    projectId: string,
    kind: 'cloud' | 'device' | 'destroyed' | 'erased'
  ): ShelfChange =>
    kind === 'cloud' || kind === 'device'
      ? {
          kind: 'landed',
          sequence,
          accountId: 'acct',
          projectId,
          inAccount: kind === 'cloud',
          at: 0
        }
      : {
          kind: 'removed',
          sequence,
          projectId,
          fromDevice: kind === 'destroyed',
          at: 0
        };

  it('names the landed copies the account holds, and only those', () => {
    const listed = new Set(['listed']);
    const next = withLandedCloudCopies(listed, [
      change(1, 'cloud', 'cloud'),
      change(2, 'device', 'device')
    ]);
    expect([...next].sort()).toEqual(['cloud', 'listed']);
    expect(withLandedCloudCopies(listed, [])).toBe(listed);
  });

  it('drops projects deleted after the listing read the account', () => {
    const listed = new Set(['copy', 'erased', 'kept']);
    expect([
      ...withLandedCloudCopies(listed, [
        change(1, 'copy', 'destroyed'),
        change(2, 'erased', 'erased')
      ])
    ]).toEqual(['kept']);
    // A copy landed and destroyed since is not added either.
    expect([
      ...withLandedCloudCopies(new Set(['kept']), [
        change(3, 'late', 'cloud'),
        change(4, 'late', 'destroyed')
      ])
    ]).toEqual(['kept']);
  });
});
