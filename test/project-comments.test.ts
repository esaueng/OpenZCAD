import { describe, expect, it } from 'vitest';
import {
  MAX_PROJECT_COMMENTS,
  normalizeProjectCommentText,
  parseProjectCommentAnchor
} from '@openzcad/shared';
import {
  createProjectComment,
  deleteProjectComment,
  isProjectCommentStorageReady,
  listProjectComments,
  parseCreateProjectCommentRequest,
  parseResolveProjectCommentRequest,
  ProjectCommentRequestError,
  resolveProjectComment,
  type CommentActor
} from '../apps/web/worker/projectComments';
import { d1Database, migratedDatabase } from './d1-sqlite';

const anchor = {
  point: [1, 2, 3] as [number, number, number],
  documentVersion: 4
};
const owner: CommentActor = {
  userId: 'user_owner',
  name: 'Olive',
  role: 'owner'
};
const editor: CommentActor = {
  userId: 'user_editor',
  name: 'Ed',
  role: 'editor'
};
const viewer: CommentActor = {
  userId: 'user_viewer',
  name: 'Vi',
  role: 'viewer'
};

function setup() {
  const sqlite = migratedDatabase();
  for (const user of ['user_owner', 'user_editor', 'user_viewer'])
    sqlite
      .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
      .run(user, `${user}@example.com`, '2026-11-16');
  sqlite
    .prepare(
      'INSERT INTO projects (id, user_id, name, document_json, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run('proj_a', 'user_owner', 'A', '{}', '2026-11-16', 'active');
  return { sqlite, db: d1Database(sqlite) };
}

async function refusal(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ProjectCommentRequestError);
  return (error as ProjectCommentRequestError).status;
}

describe('L08 comments (plaintext projects, migration 0058)', () => {
  it('pins threads, takes replies from every role, and lists them in order', async () => {
    const { db } = setup();
    expect(await isProjectCommentStorageReady(db)).toBe(true);
    const thread = await createProjectComment(db, 'proj_a', viewer, {
      anchor,
      text: 'Is this wall thick enough?'
    });
    expect(thread).toMatchObject({
      projectId: 'proj_a',
      parentId: null,
      anchor,
      authorName: 'Vi',
      authorUserId: 'user_viewer',
      resolvedAt: null
    });
    const reply = await createProjectComment(db, 'proj_a', editor, {
      parentId: thread.commentId,
      text: 'Yes, 3 mm.'
    });
    expect(reply.anchor).toBeNull();
    // A reply to a reply goes to the thread instead.
    expect(
      await refusal(
        createProjectComment(db, 'proj_a', owner, {
          parentId: reply.commentId,
          text: 'Nested'
        })
      )
    ).toBe(400);
    // A thread of another project is not found here.
    expect(
      await refusal(
        createProjectComment(db, 'proj_other', owner, {
          parentId: thread.commentId,
          text: 'Elsewhere'
        })
      )
    ).toBe(404);
    expect(
      (await listProjectComments(db, 'proj_a')).map((comment) => comment.text)
    ).toEqual(['Is this wall thick enough?', 'Yes, 3 mm.']);
  });

  it('resolves by author, editor or owner, and deletes by author or owner', async () => {
    const { db } = setup();
    const mine = await createProjectComment(db, 'proj_a', editor, {
      anchor,
      text: 'Fillet here'
    });
    expect(
      await refusal(
        resolveProjectComment(db, 'proj_a', mine.commentId, viewer, true)
      )
    ).toBe(403);
    const resolved = await resolveProjectComment(
      db,
      'proj_a',
      mine.commentId,
      owner,
      true
    );
    expect(resolved.resolvedByName).toBe('Olive');
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await resolveProjectComment(
      db,
      'proj_a',
      mine.commentId,
      editor,
      false
    );
    expect(reopened.resolvedAt).toBeNull();
    const reply = await createProjectComment(db, 'proj_a', viewer, {
      parentId: mine.commentId,
      text: 'Agreed'
    });
    expect(
      await refusal(
        resolveProjectComment(db, 'proj_a', reply.commentId, owner, true)
      )
    ).toBe(400);
    // Only the author or the owner deletes; a thread takes its replies.
    expect(
      await refusal(deleteProjectComment(db, 'proj_a', mine.commentId, viewer))
    ).toBe(403);
    await deleteProjectComment(db, 'proj_a', reply.commentId, viewer);
    await createProjectComment(db, 'proj_a', viewer, {
      parentId: mine.commentId,
      text: 'Again'
    });
    await deleteProjectComment(db, 'proj_a', mine.commentId, owner);
    expect(await listProjectComments(db, 'proj_a')).toEqual([]);
  });

  it('holds at most the limit, and goes with its project', async () => {
    const { sqlite, db } = setup();
    for (let index = 0; index < MAX_PROJECT_COMMENTS; index += 1)
      sqlite
        .prepare(
          `INSERT INTO project_comments (id, project_id, parent_id, author_user_id,
             author_name, body_text, anchor_json, created_at)
           VALUES (?, 'proj_a', NULL, 'user_owner', 'Olive', 'x', '{}', ?)`
        )
        .run(`cmt_seed_${index}`, '2026-11-16');
    expect(
      await refusal(
        createProjectComment(db, 'proj_a', owner, { anchor, text: 'One more' })
      )
    ).toBe(409);
    sqlite.prepare("DELETE FROM projects WHERE id = 'proj_a'").run();
    expect(await listProjectComments(db, 'proj_a')).toEqual([]);
  });

  it('refuses writes while an erasure is under way', async () => {
    const { sqlite, db } = setup();
    sqlite
      .prepare(
        `INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at)
         VALUES ('user_viewer', 'all', 1, 1)`
      )
      .run();
    await expect(
      createProjectComment(db, 'proj_a', viewer, { anchor, text: 'Late' })
    ).rejects.toThrow('ACCOUNT_ERASURE_IN_PROGRESS');
  });

  it('refuses a write that reaches the database after the project was encrypted', async () => {
    const { sqlite, db } = setup();
    const thread = await createProjectComment(db, 'proj_a', owner, {
      anchor,
      text: 'Before encryption'
    });
    // The route's plaintext check passed; the project is encrypted before
    // the write lands.
    sqlite
      .prepare("UPDATE projects SET storage_format = 2 WHERE id = 'proj_a'")
      .run();
    expect(
      await refusal(
        createProjectComment(db, 'proj_a', owner, { anchor, text: 'After' })
      )
    ).toBe(409);
    expect(
      await refusal(
        resolveProjectComment(db, 'proj_a', thread.commentId, owner, true)
      )
    ).toBe(409);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM project_comments').get()
    ).toEqual({ n: 1 });
  });

  it('parses only well-formed requests and anchors', () => {
    expect(
      parseCreateProjectCommentRequest({ anchor, text: '  Look  ' })
    ).toEqual({ anchor, text: 'Look' });
    expect(
      parseCreateProjectCommentRequest({ parentId: 'cmt_x', text: 'Reply' })
    ).toEqual({ parentId: 'cmt_x', text: 'Reply' });
    for (const bad of [
      null,
      { text: 'No pin' },
      { anchor, text: '' },
      { anchor, text: 'x'.repeat(2001) },
      { anchor, text: 'x', extra: true },
      { parentId: 'cmt_x', anchor, text: 'Both' },
      { anchor: { ...anchor, point: [1, 2, Number.NaN] }, text: 'x' },
      { anchor: { ...anchor, point: [1, 2, 1e9] }, text: 'x' }
    ])
      expect(() => parseCreateProjectCommentRequest(bad)).toThrow(
        ProjectCommentRequestError
      );
    expect(parseResolveProjectCommentRequest({ resolved: true })).toBe(true);
    expect(() =>
      parseResolveProjectCommentRequest({ resolved: 'yes' })
    ).toThrow(ProjectCommentRequestError);
    expect(parseProjectCommentAnchor({ ...anchor, bodyId: '' })).toBeNull();
    expect(
      parseProjectCommentAnchor({ ...anchor, normal: [0, 0, 1], bodyId: 'b' })
    ).toEqual({ ...anchor, normal: [0, 0, 1], bodyId: 'b' });
    expect(normalizeProjectCommentText('a\u0000b\nc')).toBe('ab\nc');
  });
});
