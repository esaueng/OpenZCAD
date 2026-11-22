/**
 * L08 review comments on an end-to-end encrypted project (held for the
 * owner, #1667): the owner's and a viewer's devices run the real comments
 * client (`encryptedComments.ts`) over the real Worker and SQLite. Each
 * member keeps one signed, encrypted comment log; the account stores
 * ciphertext only.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fromBase64Url } from '../packages/crypto/src/bytes';
import { parseVersionSignature } from '../packages/crypto/src/signing';
import { forgetAllProjectKeys } from '../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  EncryptedCommentsIntegrityError,
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
    const [thread] = (await mine.list(projectId, OWNER)).comments;
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
    const seen = (await theirs.list(projectId, OWNER)).comments;
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
    const [ownerThread, spam] = (await mine.list(projectId, OWNER)).comments;
    await theirs.resolve(projectId, OWNER, 'Vi', ownerThread!.commentId, true);
    expect(
      (await mine.list(projectId, OWNER)).comments[0]?.resolvedAt
    ).toBeNull();
    await mine.remove(projectId, OWNER, 'Olive', spam!.commentId);
    expect(
      (await theirs.list(projectId, OWNER)).comments.map((c) => c.text)
    ).toEqual(['Owner thread']);
  });

  it('never trusts or overwrites an own log that does not verify', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
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
    await theirs.create(projectId, OWNER, 'Vi', {
      anchor,
      text: 'Viewer thread'
    });
    expect((await theirs.list(projectId, OWNER)).comments).toHaveLength(2);
    expect((await mine.list(projectId, OWNER)).comments).toHaveLength(2);
    srv.db.exec('DROP TRIGGER e2ee_comment_log_forward');
    // The genuine envelope with a corrupted signature: the hash matches what
    // the viewer pinned, but it does not verify, so nothing is written over it.
    const viewerLog = rows<{ signature: string }>(
      srv,
      'SELECT signature FROM e2ee_project_comment_logs WHERE user_id = ?',
      OTHER
    )[0]!;
    // A character inside r || s: the record is `u8 version | u64 signedAt
    // | 64-byte r || s`, so base64url character 12 holds 6 bits of r's
    // first byte. The last character carries padding bits the decoder
    // ignores (a final "AA" turned into "AB" left the bytes unchanged, 1 run
    // in 256), and the first is the version, refused before verification.
    const at = 12;
    const flipped = `${viewerLog.signature.slice(0, at)}${viewerLog.signature[at] === 'A' ? 'B' : 'A'}${viewerLog.signature.slice(at + 1)}`;
    // Still a v1 record with the same timestamp, so verification runs and fails.
    const original = parseVersionSignature(fromBase64Url(viewerLog.signature));
    const corrupted = parseVersionSignature(fromBase64Url(flipped));
    expect(corrupted.signedAt).toBe(original.signedAt);
    expect(corrupted.rs).not.toEqual(original.rs);
    srv.db
      .prepare(
        'UPDATE e2ee_project_comment_logs SET signature = ? WHERE user_id = ?'
      )
      .run(flipped, OTHER);
    await expect(
      theirs.create(projectId, OWNER, 'Vi', { anchor, text: 'Overwrite?' })
    ).rejects.toBeInstanceOf(EncryptedCommentsIntegrityError);
    expect(
      rows(
        srv,
        'SELECT sequence FROM e2ee_project_comment_logs WHERE user_id = ?',
        OTHER
      )
    ).toEqual([{ sequence: 1 }]);
    srv.db
      .prepare(
        'UPDATE e2ee_project_comment_logs SET signature = ? WHERE user_id = ?'
      )
      .run(viewerLog.signature, OTHER);
    // The account serves the owner's envelope as the viewer's own log.
    const ownerLog = rows<Record<string, unknown>>(
      srv,
      'SELECT * FROM e2ee_project_comment_logs WHERE user_id = ?',
      OWNER
    )[0]!;
    srv.db
      .prepare(
        `UPDATE e2ee_project_comment_logs
         SET envelope = ?, signature = ?, signer_device_id = ?
         WHERE user_id = ?`
      )
      .run(
        ownerLog.envelope as string,
        ownerLog.signature as string,
        ownerLog.signer_device_id as string,
        OTHER
      );
    // The viewer's own log is not the one it saw: refused, and nothing is
    // written over it.
    await expect(theirs.list(projectId, OWNER)).rejects.toThrow();
    await expect(
      theirs.create(projectId, OWNER, 'Vi', { anchor, text: 'Lost?' })
    ).rejects.toThrow();
    expect(
      rows<{ envelope: string }>(
        srv,
        'SELECT envelope FROM e2ee_project_comment_logs WHERE user_id = ?',
        OTHER
      )[0]?.envelope
    ).toBe(ownerLog.envelope);
    // The owner, who saw the viewer's log, is told it was left out.
    const seenByOwner = await mine.list(projectId, OWNER);
    expect(seenByOwner.comments.map((c) => c.text)).toEqual(['Owner thread']);
    expect(seenByOwner.warning).toContain('left out');
  });

  it('reports a member log rolled back, forked or withdrawn, and refuses its own', async () => {
    const { srv, laptop, member, projectId } = await sharedProject(
      [owner, other],
      owner,
      other,
      'viewer'
    );
    const mine = comments(laptop);
    const theirs = comments(member);
    await theirs.create(projectId, OWNER, 'Vi', { anchor, text: 'One' });
    const firstViewerLog = rows<Record<string, unknown>>(
      srv,
      'SELECT * FROM e2ee_project_comment_logs WHERE user_id = ?',
      OTHER
    )[0]!;
    await theirs.create(projectId, OWNER, 'Vi', { anchor, text: 'Two' });
    // The owner sees the viewer's log at sequence 2.
    expect((await mine.list(projectId, OWNER)).comments).toHaveLength(2);
    srv.db.exec('DROP TRIGGER e2ee_comment_log_forward');
    // Rolled back to sequence 1: left out and reported, not hidden.
    srv.db
      .prepare(
        `UPDATE e2ee_project_comment_logs
         SET envelope = ?, signature = ?, sequence = 1 WHERE user_id = ?`
      )
      .run(
        firstViewerLog.envelope as string,
        firstViewerLog.signature as string,
        OTHER
      );
    const rolledBack = await mine.list(projectId, OWNER);
    expect(rolledBack.comments).toEqual([]);
    expect(rolledBack.warning).toContain('older version');
    // Served at a higher sequence without descending from what was seen:
    // the version-1 envelope relabelled 3 names no ancestor, so it forks.
    srv.db
      .prepare(
        'UPDATE e2ee_project_comment_logs SET sequence = 3 WHERE user_id = ?'
      )
      .run(OTHER);
    const forked = await mine.list(projectId, OWNER);
    expect(forked.comments).toEqual([]);
    expect(forked.warning).toBeTruthy();
    // Withdrawn altogether: reported too.
    srv.db
      .prepare('DELETE FROM e2ee_project_comment_logs WHERE user_id = ?')
      .run(OTHER);
    const withdrawn = await mine.list(projectId, OWNER);
    expect(withdrawn.warning).toContain('no longer serves');
    // The viewer's own browser refuses its own log rolled back or withdrawn.
    await expect(theirs.list(projectId, OWNER)).rejects.toBeInstanceOf(
      ReplacedEnvelopeRollbackError
    );
  });
});
