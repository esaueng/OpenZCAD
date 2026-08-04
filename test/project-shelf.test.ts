import { describe, expect, it } from 'vitest';
import {
  applyOrganizationUpdate,
  compareProjectSummaries,
  daysUntilPurge,
  duplicateProjectName,
  isPurgeDue,
  MAX_PROJECT_NAME_LENGTH,
  projectOrganization,
  toProjectId,
  TRASH_RETENTION_MS,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import {
  applyLocalProjectOrganizations,
  bucketProjectsByShelf,
  mergeProjectSummaries,
  moveItem
} from '../apps/web/src/lib/projectShelf';

function summary(
  id: string,
  updatedAt: string,
  organization?: Partial<ProjectOrganization>
): ProjectSummary {
  return {
    projectId: toProjectId(id),
    name: id,
    revisionCount: 1,
    updatedAt,
    ...(organization
      ? {
          organization: {
            status: 'active',
            pinned: false,
            sortOrder: 0,
            ...organization
          }
        }
      : {})
  };
}

describe('shelf state', () => {
  it('stamps the move that put a project on a shelf', () => {
    const archived = applyOrganizationUpdate(
      { status: 'active', pinned: false, sortOrder: 3 },
      { status: 'archived' },
      '2026-01-01T00:00:00.000Z'
    );
    expect(archived).toMatchObject({
      status: 'archived',
      archivedAt: '2026-01-01T00:00:00.000Z',
      sortOrder: 3
    });

    // Archive → bin restamps, so the countdown runs from the deletion.
    const binned = applyOrganizationUpdate(
      archived,
      { status: 'deleted' },
      '2026-02-01T00:00:00.000Z'
    );
    expect(binned.deletedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(binned.archivedAt).toBeUndefined();

    // Restoring clears both, so a second trip to the bin starts a new window.
    const restored = applyOrganizationUpdate(binned, { status: 'active' });
    expect(restored.status).toBe('active');
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.archivedAt).toBeUndefined();
  });

  it('keeps the original deletion time when a binned project is only re-pinned', () => {
    const binned = applyOrganizationUpdate(
      { status: 'active', pinned: false, sortOrder: 0 },
      { status: 'deleted' },
      '2026-03-01T00:00:00.000Z'
    );
    const repinned = applyOrganizationUpdate(
      binned,
      { pinned: true },
      '2026-03-09T00:00:00.000Z'
    );
    expect(repinned.deletedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('counts whole days left and only purges once the window has closed', () => {
    const deletedAt = '2026-01-01T00:00:00.000Z';
    const due = Date.parse(deletedAt) + TRASH_RETENTION_MS;
    expect(daysUntilPurge(deletedAt, Date.parse(deletedAt))).toBe(30);
    expect(daysUntilPurge(deletedAt, due - 1)).toBe(1);
    expect(daysUntilPurge(deletedAt, due)).toBe(0);
    expect(isPurgeDue(deletedAt, due - 1)).toBe(false);
    expect(isPurgeDue(deletedAt, due)).toBe(true);
    // A record with no or an unreadable timestamp is never destroyed silently.
    expect(isPurgeDue(undefined, due)).toBe(false);
    expect(isPurgeDue('not a date', due)).toBe(false);
  });

  it('sorts pinned projects first, then manual order, then recency', () => {
    const projects = [
      summary('old-pinned', '2026-01-01T00:00:00.000Z', {
        pinned: true,
        sortOrder: 9
      }),
      summary('manual-first', '2026-01-02T00:00:00.000Z', { sortOrder: 0 }),
      summary('manual-second', '2026-06-01T00:00:00.000Z', { sortOrder: 1 })
    ];
    expect(
      [...projects].sort(compareProjectSummaries).map((p) => p.projectId)
    ).toEqual(['old-pinned', 'manual-first', 'manual-second']);
  });

  it('splits projects onto their shelves', () => {
    const shelves = bucketProjectsByShelf([
      summary('a', '2026-01-01T00:00:00.000Z'),
      summary('b', '2026-01-01T00:00:00.000Z', { status: 'archived' }),
      summary('c', '2026-01-01T00:00:00.000Z', { status: 'deleted' })
    ]);
    expect(shelves.active.map((p) => p.projectId)).toEqual(['a']);
    expect(shelves.archived.map((p) => p.projectId)).toEqual(['b']);
    expect(shelves.deleted.map((p) => p.projectId)).toEqual(['c']);
  });
});

describe('merging device and account projects', () => {
  it('lets the device decide the shelf while recency decides the record', () => {
    const local = summary('shared', '2026-01-01T00:00:00.000Z', {
      status: 'archived'
    });
    const remote = {
      ...summary('shared', '2026-06-01T00:00:00.000Z', { status: 'active' }),
      name: 'renamed remotely'
    };
    const [merged] = mergeProjectSummaries([local], [remote]);
    expect(merged?.name).toBe('renamed remotely');
    expect(projectOrganization(merged!).status).toBe('archived');
  });

  it('adopts the account shelf for a project this device never organised', () => {
    const local = summary('shared', '2026-01-01T00:00:00.000Z');
    const remote = summary('shared', '2026-01-01T00:00:00.000Z', {
      status: 'deleted',
      deletedAt: '2026-01-01T00:00:00.000Z'
    });
    const [merged] = mergeProjectSummaries([local], [remote]);
    expect(projectOrganization(merged!).status).toBe('deleted');
  });

  it('keeps projects that exist in only one store', () => {
    const merged = mergeProjectSummaries(
      [summary('local-only', '2026-01-01T00:00:00.000Z')],
      [summary('remote-only', '2026-02-01T00:00:00.000Z')]
    );
    expect(merged.map((project) => project.projectId).sort()).toEqual([
      'local-only',
      'remote-only'
    ]);
  });

  it('applies device shelf state to a cloud-only project', () => {
    const remote = summary('remote-only', '2026-02-01T00:00:00.000Z', {
      status: 'active'
    });
    const deleted: ProjectOrganization = {
      status: 'deleted',
      pinned: false,
      sortOrder: 4,
      deletedAt: '2026-03-01T00:00:00.000Z'
    };
    const [merged] = applyLocalProjectOrganizations(
      [remote],
      new Map([[remote.projectId, deleted]])
    );
    expect(projectOrganization(merged!)).toEqual(deleted);
  });
});

describe('reordering', () => {
  it('moves an item without disturbing the rest', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('returns the same list for a drop that lands nowhere', () => {
    const list = ['a', 'b'];
    expect(moveItem(list, 0, 0)).toBe(list);
    expect(moveItem(list, 0, 5)).toBe(list);
    expect(moveItem(list, -1, 1)).toBe(list);
  });
});

describe('copy names', () => {
  it('extends the counter instead of nesting suffixes', () => {
    expect(duplicateProjectName('Bracket', [])).toBe('Bracket (copy)');
    expect(duplicateProjectName('Bracket', ['Bracket (copy)'])).toBe(
      'Bracket (copy 2)'
    );
    expect(duplicateProjectName('Bracket (copy)', ['bracket (copy)'])).toBe(
      'Bracket (copy 2)'
    );
  });

  it('never produces a name the server would reject as too long', () => {
    const name = duplicateProjectName('x'.repeat(MAX_PROJECT_NAME_LENGTH), []);
    expect(name.length).toBeLessThanOrEqual(MAX_PROJECT_NAME_LENGTH);
    expect(name.endsWith('(copy)')).toBe(true);
  });
});
