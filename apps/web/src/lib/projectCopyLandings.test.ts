import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_ORGANIZATION,
  toProjectId,
  type ProjectSummary
} from '@openzcad/shared';
import {
  createProjectCopyLandings,
  withLandedCloudCopies,
  withLandedCopies
} from './projectCopyLandings';

const row = (projectId: string, name = projectId): ProjectSummary => ({
  projectId: toProjectId(projectId),
  name,
  revisionCount: 1,
  updatedAt: '2026-11-26T10:00:00.000Z'
});

const ids = (projects: readonly ProjectSummary[]) =>
  projects.map((project) => project.projectId);

describe('createProjectCopyLandings', () => {
  it('keeps for a listing only the copies that landed after it began', () => {
    const landings = createProjectCopyLandings();
    const before = landings.beginListing('acct');
    landings.land('acct', 'early', false);
    const listing = landings.beginListing('acct');
    landings.land('acct', 'late', true);
    landings.listingReturned(listing);
    expect(
      landings.takeLandedSince(listing).map((record) => record.projectId)
    ).toEqual(['late']);
    expect(
      landings.takeLandedSince(before).map((record) => record.projectId)
    ).toEqual(['early', 'late']);
  });

  it('gives the same copies when a result is read twice as it is applied', () => {
    const landings = createProjectCopyLandings();
    const listing = landings.beginListing(null);
    landings.land(null, 'copy', false);
    expect(landings.takeLandedSince(listing)).toHaveLength(1);
    expect(landings.takeLandedSince(listing)).toHaveLength(1);
  });

  it('never hands one account’s copies to another account’s listing', () => {
    const landings = createProjectCopyLandings();
    const signedOut = landings.beginListing(null);
    const other = landings.beginListing('other');
    const own = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    expect(landings.takeLandedSince(signedOut)).toEqual([]);
    expect(landings.takeLandedSince(other)).toEqual([]);
    expect(landings.takeLandedSince(own)).toHaveLength(1);
  });

  it('records nothing while no listing could have missed the copy', () => {
    const landings = createProjectCopyLandings();
    landings.land('acct', 'copy', true);
    expect(landings.size).toBe(0);
    expect(landings.takeLandedSince(landings.beginListing('acct'))).toEqual([]);
  });

  it('drops a record once no listing that began before it is out', () => {
    const landings = createProjectCopyLandings();
    const first = landings.beginListing('acct');
    landings.land('acct', 'a', false);
    const second = landings.beginListing('acct');
    landings.land('acct', 'b', false);
    expect(landings.size).toBe(2);
    landings.takeLandedSince(first);
    // `a` landed before `second` began, so only `first` needed it.
    landings.beginListing('acct');
    expect(landings.size).toBe(1);
    landings.takeLandedSince(second);
    landings.land('acct', 'c', false);
    // The third listing is still out, so only `c` (after it began) is held.
    expect(landings.size).toBe(1);
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
    expect(landings.takeLandedSince(stalled)).toEqual([]);
  });

  it('forgets a copy the user destroyed', () => {
    const landings = createProjectCopyLandings();
    const listing = landings.beginListing('acct');
    landings.land('acct', 'copy', true);
    landings.forget(['copy']);
    expect(landings.takeLandedSince(listing)).toEqual([]);
  });
});

describe('withLandedCopies', () => {
  const landed = (projectId: string, inAccount = false) => ({
    sequence: 1,
    accountId: 'acct',
    projectId,
    inAccount,
    landedAt: 0
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
    const trashed: ProjectSummary = {
      ...row('copy'),
      organization: {
        ...DEFAULT_PROJECT_ORGANIZATION,
        status: 'deleted',
        deletedAt: '2026-11-26T10:01:00.000Z'
      }
    };
    expect(
      withLandedCopies([row('listed')], [trashed], [landed('copy')]).find(
        (project) => project.projectId === 'copy'
      )
    ).toBe(trashed);
    expect(
      ids(withLandedCopies([row('listed')], [row('listed')], [landed('copy')]))
    ).toEqual(['listed']);
  });

  it('returns the listing itself when nothing is added', () => {
    const listed = [row('listed')];
    expect(withLandedCopies(listed, [], [])).toBe(listed);
    expect(withLandedCopies(listed, listed, [landed('listed')])).toBe(listed);
  });
});

describe('withLandedCloudCopies', () => {
  it('names the landed copies the account holds, and only those', () => {
    const listed = new Set(['listed']);
    const next = withLandedCloudCopies(listed, [
      {
        sequence: 1,
        accountId: 'acct',
        projectId: 'cloud',
        inAccount: true,
        landedAt: 0
      },
      {
        sequence: 2,
        accountId: 'acct',
        projectId: 'device',
        inAccount: false,
        landedAt: 0
      }
    ]);
    expect([...next].sort()).toEqual(['cloud', 'listed']);
    expect(withLandedCloudCopies(listed, [])).toBe(listed);
  });
});
