import { describe, expect, it } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import { ownProjectBehindShare } from './shareOwnProject';

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

  it('reads an account project the listing leaves unmarked as the owner’s', () => {
    const unmarked = summary('proj_own');
    expect(
      ownProjectBehindShare({
        signedIn: true,
        projectId: 'proj_own',
        projects: [unmarked],
        accountProjectIds
      })
    ).toBe(unmarked);
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
