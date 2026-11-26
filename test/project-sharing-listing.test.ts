import { describe, expect, it } from 'vitest';
import {
  PROJECT_SHARE_LINK_TTL_SECONDS,
  toProjectId,
  type ProjectSummary
} from '@openzcad/shared';
import { withProjectSharing } from '../apps/web/worker/projectSharingListing';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const OWNER = 'user_owner';
const FRIEND = 'user_friend';
const NOW = 1_800_000_000;

function summary(projectId: string): ProjectSummary {
  return {
    projectId: toProjectId(projectId),
    name: projectId,
    revisionCount: 1,
    updatedAt: '2026-11-01T00:00:00.000Z'
  };
}

function seeded() {
  const db = migratedDatabase();
  for (const [id, email] of [
    [OWNER, 'owner@example.com'],
    [FRIEND, 'friend@example.com']
  ] as const) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(id, email, '2026-10-14T00:00:00.000Z');
  }
  const project = (id: string, userId: string) =>
    db
      .prepare(
        `INSERT INTO projects (id, user_id, name, document_json, updated_at)
         VALUES (?, ?, ?, '{}', '2026-11-01T00:00:00.000Z')`
      )
      .run(id, userId, id);
  const member = (projectId: string, userId: string, role: string) =>
    db
      .prepare(
        `INSERT INTO project_members
           (project_id, user_id, role, added_by_user_id, created_at, updated_at)
         SELECT ?, ?, ?, p.user_id, ?, ? FROM projects p WHERE p.id = ?`
      )
      .run(projectId, userId, role, NOW, NOW, projectId);
  const link = (
    id: string,
    projectId: string,
    createdAt: number,
    revokedAt: number | null = null
  ) =>
    db
      .prepare(
        `INSERT INTO project_share_links
           (id, project_id, mode, token_hash, created_by_user_id, created_at, revoked_at)
         VALUES (?, ?, 'view', ?, ?, ?, ?)`
      )
      .run(id, projectId, id.padEnd(64, 'x'), OWNER, createdAt, revokedAt);
  return { db, project, member, link };
}

describe('withProjectSharing (GET /api/projects)', () => {
  it('marks shared-with-you and shared-by-you projects, and leaves the rest', async () => {
    const { db, project, member, link } = seeded();
    project('mine_alone', OWNER);
    project('mine_with_member', OWNER);
    project('mine_with_link', OWNER);
    project('mine_with_dead_links', OWNER);
    project('theirs', FRIEND);
    member('mine_with_member', FRIEND, 'editor');
    link('link_live', 'mine_with_link', NOW - 60);
    link('link_live_2', 'mine_with_link', NOW - 120);
    link('link_member', 'mine_with_member', NOW - 60);
    link('link_revoked', 'mine_with_dead_links', NOW - 60, NOW - 30);
    link(
      'link_expired',
      'mine_with_dead_links',
      NOW - PROJECT_SHARE_LINK_TTL_SECONDS - 1
    );
    member('theirs', OWNER, 'viewer');

    const listing = await withProjectSharing(
      sqliteD1(db),
      OWNER,
      {
        projects: [
          'mine_alone',
          'mine_with_member',
          'mine_with_link',
          'mine_with_dead_links',
          'theirs'
        ].map(summary)
      },
      NOW
    );
    const sharing = Object.fromEntries(
      listing.projects.map((project) => [project.projectId, project.sharing])
    );

    expect(sharing).toEqual({
      mine_alone: undefined,
      mine_with_member: { role: 'owner', memberCount: 1, linkCount: 1 },
      mine_with_link: { role: 'owner', linkCount: 2 },
      mine_with_dead_links: undefined,
      theirs: { role: 'viewer' }
    });
    expect(
      listing.projects.find((project) => project.projectId === 'mine_alone')
    ).not.toHaveProperty('sharing');
  });

  it('counts an encrypted project’s unrevoked links', async () => {
    const { db, project } = seeded();
    project('sealed', OWNER);
    const e2eeLink = (shareId: string, revokedAt: string | null) =>
      db
        .prepare(
          `INSERT INTO e2ee_share_links
             (project_id, share_id, token_hash, mode, share_key_hash,
              owner_identity_hash, created_by_user_id, created_at, revoked_at)
           VALUES ('sealed', ?, ?, 'view', ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)`
        )
        .run(
          shareId,
          shareId.padEnd(64, '0'),
          shareId.padEnd(43, 'k'),
          'o'.repeat(43),
          OWNER,
          revokedAt
        );
    e2eeLink('live', null);
    e2eeLink('gone', '2026-11-02T00:00:00.000Z');

    const listing = await withProjectSharing(
      sqliteD1(db),
      OWNER,
      { projects: [summary('sealed')] },
      NOW
    );

    expect(listing.projects[0]?.sharing).toEqual({
      role: 'owner',
      linkCount: 1
    });
  });

  it('never fails the listing', async () => {
    const listing = { projects: [summary('anything')] };
    const broken = {
      prepare() {
        throw new Error('D1 unavailable');
      }
    } as unknown as D1Database;

    await expect(withProjectSharing(broken, OWNER, listing)).resolves.toBe(
      listing
    );
    await expect(withProjectSharing(undefined, OWNER, listing)).resolves.toBe(
      listing
    );
  });
});
