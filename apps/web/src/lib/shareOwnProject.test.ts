import { describe, expect, it } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import {
  ownProjectBehindShare,
  shareBuildModeLockReason,
  shareSessionKeepsView
} from './shareOwnProject';

const summary = (
  id: string,
  sharing?: ProjectSummary['sharing']
): ProjectSummary => ({
  projectId: toProjectId(id),
  name: id,
  revisionCount: 1,
  updatedAt: '2026-11-26T00:00:00.000Z',
  ...(sharing ? { sharing } : {})
});

describe('ownProjectBehindShare', () => {
  const own = summary('proj_own', { role: 'owner', linkCount: 1 });
  const theirs = summary('proj_theirs', { role: 'editor' });
  const projects = [own, theirs, summary('proj_device')];
  const accountProjectIds = new Set(['proj_own', 'proj_theirs']);

  it('finds the signed-in owner’s project behind their own link', () => {
    expect(
      ownProjectBehindShare({
        signedIn: true,
        projectId: 'proj_own',
        projects,
        accountProjectIds
      })
    ).toBe(own);
  });

  it('offers a copy when the listing does not mark the project’s role', () => {
    // The Worker returns the listing without sharing marks when its sharing
    // lookup fails: a collaborator's project then looks like any other.
    const unmarked = summary('proj_theirs');
    expect(
      ownProjectBehindShare({
        signedIn: true,
        projectId: 'proj_theirs',
        projects: [unmarked],
        accountProjectIds
      })
    ).toBeNull();
  });

  it('offers a copy for a role it does not know', () => {
    const unknown = summary('proj_own', {
      role: 'auditor' as never
    });
    expect(
      ownProjectBehindShare({
        signedIn: true,
        projectId: 'proj_own',
        projects: [unknown],
        accountProjectIds
      })
    ).toBeNull();
  });

  it('finds nothing for a link to someone else’s project', () => {
    for (const projectId of ['proj_theirs', 'proj_device', 'proj_unknown']) {
      expect(
        ownProjectBehindShare({
          signedIn: true,
          projectId,
          projects,
          accountProjectIds
        }),
        projectId
      ).toBeNull();
    }
  });

  it('finds nothing while signed out, whatever this device lists', () => {
    expect(
      ownProjectBehindShare({
        signedIn: false,
        projectId: 'proj_own',
        projects,
        accountProjectIds
      })
    ).toBeNull();
    expect(
      ownProjectBehindShare({
        signedIn: true,
        projectId: null,
        projects,
        accountProjectIds
      })
    ).toBeNull();
  });
});

describe('shareBuildModeLockReason', () => {
  it('points the owner to their project and a visitor to a copy', () => {
    expect(shareBuildModeLockReason(true)).toBe(
      'This is your project’s share link — Open your project to open Build mode'
    );
    expect(shareBuildModeLockReason(false)).toBe(
      'This is a shared link — Make a copy to open Build mode'
    );
  });
});

describe('shareSessionKeepsView', () => {
  const projects = [summary('proj_own', { role: 'owner', linkCount: 1 })];

  it('keeps no view for a project this device or account lists', () => {
    expect(shareSessionKeepsView('proj_own', projects)).toBe(false);
    // Listed without sharing marks (a failed lookup, or a device project).
    expect(shareSessionKeepsView('proj_own', [summary('proj_own')])).toBe(
      false
    );
  });

  it('keeps a visitor’s view of a project they do not have', () => {
    expect(shareSessionKeepsView('proj_elsewhere', projects)).toBe(true);
    expect(shareSessionKeepsView(null, projects)).toBe(true);
  });
});
