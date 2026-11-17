import { describe, expect, it } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectComment } from '@openzcad/shared';
import { hashProjectInvitationToken } from '../apps/web/worker/sharing';
import {
  listProjectComments,
  parseLinkCommentRequest,
  ProjectCommentRequestError
} from '../apps/web/worker/projectComments';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

const token = (seed: string) => seed.repeat(43).slice(0, 43);

function database() {
  const document = createProjectDocument('Bracket', toUserId('user_owner'));
  const db = migratedDatabase();
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    document.ownerUserId,
    'owner@example.com',
    '2026-11-16T00:00:00.000Z'
  );
  db.prepare(
    `INSERT INTO projects (id, user_id, name, document_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    document.projectId,
    document.ownerUserId,
    document.name,
    JSON.stringify(document),
    '2026-11-16T00:00:00.000Z'
  );
  const env = {
    ENVIRONMENT: 'development' as const,
    AUTH_MODE: 'development' as const,
    ARTIFACTS: {} as R2Bucket,
    PROJECT_SHARING_ENABLED: 'true',
    DB: sqliteD1(db)
  };
  return { db, document, env, service: new D1R2PersistenceService(env) };
}

async function link(
  service: D1R2PersistenceService,
  document: ReturnType<typeof database>['document'],
  id: string,
  seed: string,
  comments: boolean
) {
  return service.createProjectShareLink(
    document.ownerUserId,
    document.projectId,
    {
      shareLinkId: id,
      mode: 'tweak',
      tokenHash: await hashProjectInvitationToken(token(seed)),
      createdAt: Math.floor(Date.now() / 1000),
      ...(comments ? { comments } : {})
    }
  );
}

const anchor = { point: [1, 2, 3], documentVersion: 1 };

describe('L08 commenter links (migration 0059)', () => {
  it('marks a commenter link everywhere the owner and the visitor read it', async () => {
    const { document, service } = database();
    expect(await link(service, document, 'share_c', 'c', true)).toMatchObject({
      comments: true
    });
    expect(
      await link(service, document, 'share_p', 'p', false)
    ).not.toHaveProperty('comments');
    const listed = await service.listProjectShareLinks(
      document.ownerUserId,
      document.projectId
    );
    expect(
      Object.fromEntries(
        listed.map((entry) => [entry.shareLinkId, entry.comments ?? false])
      )
    ).toEqual({ share_c: true, share_p: false });
    const shared = await service.loadSharedProjectByTokenHash(
      await hashProjectInvitationToken(token('c'))
    );
    expect(shared?.comments).toBe(true);
  });

  it('lets a commenter link’s visitor read and write, signed and without an account', async () => {
    const { db, document, env, service } = database();
    await link(service, document, 'share_c', 'c', true);
    await link(service, document, 'share_p', 'p', false);
    // As the browser sends it: the token in its header, not the URL.
    const visit = (seed: string, init?: RequestInit) =>
      worker.fetch(
        new Request('https://example.com/api/share/comments', {
          ...init,
          headers: { 'x-openzcad-share-token': token(seed) }
        }),
        env
      );
    const posted = await visit('c', {
      method: 'POST',
      body: JSON.stringify({ name: '  Sam  ', anchor, text: 'Chamfer this?' })
    });
    expect(posted.status).toBe(201);
    const { comment } = (await posted.json()) as { comment: ProjectComment };
    expect(comment).toMatchObject({
      authorUserId: null,
      authorName: 'Sam (via link)',
      text: 'Chamfer this?'
    });
    expect(
      db
        .prepare('SELECT author_user_id, share_link_id FROM project_comments')
        .get()
    ).toEqual({ author_user_id: null, share_link_id: 'share_c' });
    // Members see it with the rest of the project's comments.
    expect(
      (await listProjectComments(env.DB, document.projectId)).map(
        (entry) => entry.authorName
      )
    ).toEqual(['Sam (via link)']);
    const read = await visit('c');
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as { comments: ProjectComment[] }).comments
    ).toHaveLength(1);

    // A view-or-tweak link, an unknown token and a revoked link: one 404.
    expect((await visit('p')).status).toBe(404);
    expect((await visit('x')).status).toBe(404);
    expect(
      (
        await visit('p', {
          method: 'POST',
          body: JSON.stringify({ name: 'Eve', anchor, text: 'Spam' })
        })
      ).status
    ).toBe(404);
    await service.revokeProjectShareLink(
      document.ownerUserId,
      document.projectId,
      'share_c',
      Math.floor(Date.now() / 1000) + 1
    );
    expect((await visit('c')).status).toBe(404);
    // The comment outlives the link; its source is kept until the link row goes.
    expect(await listProjectComments(env.DB, document.projectId)).toHaveLength(
      1
    );
  });

  it('serves no comments for a trashed or encrypted project', async () => {
    const { db, document, env, service } = database();
    await link(service, document, 'share_c', 'c', true);
    const visit = () =>
      worker.fetch(
        new Request(`https://example.com/api/share/${token('c')}/comments`),
        env
      );
    expect((await visit()).status).toBe(200);
    db.prepare(`UPDATE projects SET status = 'deleted' WHERE id = ?`).run(
      document.projectId
    );
    expect((await visit()).status).toBe(404);
    db.prepare(
      `UPDATE projects SET status = 'active', storage_format = 2 WHERE id = ?`
    ).run(document.projectId);
    expect((await visit()).status).toBe(404);
  });

  it('answers the opaque 404 before migration 0059', async () => {
    const { db, document, env } = database();
    // A database with 0058 applied but not 0059.
    db.exec('ALTER TABLE project_comments DROP COLUMN share_link_id');
    db.exec('ALTER TABLE project_share_links DROP COLUMN allow_comments');
    db.prepare(
      `INSERT INTO project_share_links
         (id, project_id, mode, token_hash, created_by_user_id, created_at)
       VALUES ('share_c', ?, 'tweak', ?, ?, ?)`
    ).run(
      document.projectId,
      await hashProjectInvitationToken(token('c')),
      document.ownerUserId,
      Math.floor(Date.now() / 1000)
    );
    const response = await worker.fetch(
      new Request('https://example.com/api/share/comments', {
        headers: { 'x-openzcad-share-token': token('c') }
      }),
      env
    );
    expect(response.status).toBe(404);
  });

  it('needs a name of 1 to 60 characters', () => {
    expect(
      parseLinkCommentRequest({ name: 'Sam', parentId: 'cmt_x', text: 'Hi' })
    ).toEqual({ name: 'Sam', input: { parentId: 'cmt_x', text: 'Hi' } });
    for (const name of [undefined, '   ', 'x'.repeat(61), 42])
      expect(() =>
        parseLinkCommentRequest({ name, anchor, text: 'Hi' })
      ).toThrow(ProjectCommentRequestError);
  });
});
