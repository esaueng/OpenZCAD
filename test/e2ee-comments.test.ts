/**
 * L08 review comments on an end-to-end encrypted project (held for the
 * owner, #1667): the owner's and a viewer's devices run the real comments
 * client (`encryptedComments.ts`) over the real Worker and SQLite. Each
 * member keeps one signed, encrypted comment log; the account stores
 * ciphertext only.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  createEncryptedComments,
  createEncryptedCommentsApi,
  type EncryptedComments
} from '../apps/web/src/lib/e2ee/encryptedComments';
import { ReplacedEnvelopeRollbackError } from '../apps/web/src/lib/e2ee/replacedEnvelopes';
import {
  OTHER,
  OWNER,
  makeAccount,
  rows,
  type Account,
  type Device,
  type Server
} from './support/e2ee-documents';
import { sharedProject } from './support/e2ee-members';

let owner: Account;
let other: Account;

beforeAll(async () => {
  owner = await makeAccount(OWNER, ['owner_laptop']);
  other = await makeAccount(OTHER, ['other_laptop']);
});

afterEach(() => {
  forgetAllProjectKeys();
});

const anchor = {
  point: [1, 2, 3] as [number, number, number],
  documentVersion: 1
};

function comments(dev: Device): EncryptedComments {
  return createEncryptedComments({
    userId: dev.account.userId,
    kit: dev.store.replaced,
    pins: dev.pins,
    api: createEncryptedCommentsApi((path, init) => dev.fetcher(path, init))
  });
}

/** Everything the account stored, as text. */
function stored(srv: Server): string {
  const tables = rows<{ name: string }>(
    srv,
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).map((row) => row.name);
  return tables
    .map((table) => JSON.stringify(rows(srv, `SELECT * FROM "${table}"`)))
    .join('\n');
}

describe('encrypted comments (L08)', () => {
  it('lets a viewer and the owner comment, stored as ciphertext only', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      [owner, other],
      owner,
      other,
      'viewer'
    );
    const mine = comments(laptop);
    const theirs = comments(member);
    await theirs.create(projectId, OWNER, 'Vi', {
      anchor,
      text: 'Secret wall question'
    });
    const [thread] = await mine.list(projectId, OWNER);
    expect(thread).toMatchObject({
      text: 'Secret wall question',
      authorUserId: OTHER,
      authorName: 'Vi',
      anchor
    });
    await mine.create(projectId, OWNER, 'Olive', {
      parentId: thread!.commentId,
      text: 'Secret owner reply'
    });
    await mine.resolve(projectId, OWNER, 'Olive', thread!.commentId, true);
    const seen = await theirs.list(projectId, OWNER);
    expect(seen.map((c) => [c.text, c.authorName])).toEqual([
      ['Secret wall question', 'Vi'],
      ['Secret owner reply', 'Olive']
    ]);
    expect(seen[0]?.resolvedByName).toBe('Olive');
    // Nothing the members wrote reaches the account in plaintext.
    const all = stored(srv);
    for (const secret of [
      'Secret wall question',
      'Secret owner reply',
      'Olive',
      '"Vi"'
    ])
      expect(all).not.toContain(secret);
    expect(
      rows(
        srv,
        'SELECT user_id, sequence FROM e2ee_project_comment_logs ORDER BY user_id'
      )
    ).toEqual([
      { user_id: OTHER, sequence: 1 },
      { user_id: OWNER, sequence: 2 }
    ]);
  });

  it('ignores a viewer resolving the owner’s thread, and lets the owner remove a comment', async () => {
    const { laptop, member, projectId } = await sharedProject(
      [owner, other],
      owner,
      other,
      'viewer'
    );
    const mine = comments(laptop);
    const theirs = comments(member);
    await mine.create(projectId, OWNER, 'Olive', {
      anchor,
      text: 'Owner thread'
    });
    await theirs.create(projectId, OWNER, 'Vi', { anchor, text: 'Spam' });
    const [ownerThread, spam] = await mine.list(projectId, OWNER);
    await theirs.resolve(projectId, OWNER, 'Vi', ownerThread!.commentId, true);
    expect((await mine.list(projectId, OWNER))[0]?.resolvedAt).toBeNull();
    await mine.remove(projectId, OWNER, 'Olive', spam!.commentId);
    expect((await theirs.list(projectId, OWNER)).map((c) => c.text)).toEqual([
      'Owner thread'
    ]);
  });

  it('refuses a log the account rolled back or moved to another member', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      [owner, other],
      owner,
      other,
      'viewer'
    );
    const mine = comments(laptop);
    await mine.create(projectId, OWNER, 'Olive', { anchor, text: 'First' });
    const first = rows<Record<string, unknown>>(
      srv,
      'SELECT * FROM e2ee_project_comment_logs WHERE user_id = ?',
      OWNER
    )[0]!;
    await mine.create(projectId, OWNER, 'Olive', { anchor, text: 'Second' });
    // The account serves the owner's log as the viewer's: signed by the
    // owner's device, so it is left out rather than attributed to them.
    srv.db
      .prepare(
        `INSERT INTO e2ee_project_comment_logs
           (project_id, user_id, sequence, key_epoch, envelope,
            wrapped_version_key, signature, signer_device_id, updated_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        OTHER,
        first.key_epoch as number,
        first.envelope as string,
        first.wrapped_version_key as string,
        first.signature as string,
        first.signer_device_id as string,
        first.updated_at as string
      );
    const theirs = comments(member);
    expect(
      (await theirs.list(projectId, OWNER)).map((c) => c.authorUserId)
    ).toEqual([OWNER, OWNER]);
    // The account rolls the owner's log back to its first version.
    srv.db.exec('DROP TRIGGER e2ee_comment_log_forward');
    srv.db
      .prepare(
        `UPDATE e2ee_project_comment_logs
         SET envelope = ?, signature = ?, sequence = 1
         WHERE user_id = ?`
      )
      .run(first.envelope as string, first.signature as string, OWNER);
    await expect(mine.list(projectId, OWNER)).rejects.toBeInstanceOf(
      ReplacedEnvelopeRollbackError
    );
  });
});
