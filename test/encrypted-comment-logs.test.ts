import { describe, expect, it } from 'vitest';
import { commentLogFollows } from '../apps/web/src/lib/e2ee/encryptedComments';
import {
  MAX_COMMENT_LOG_ANCESTORS,
  mergeCommentLogs,
  parseCommentLog,
  type CommentLogRecord
} from '@openzcad/shared';

const id = (n: number) =>
  `cmt_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const anchor = {
  point: [1, 2, 3] as [number, number, number],
  documentVersion: 1
};

function log(
  name: string,
  overrides: Partial<CommentLogRecord> = {}
): CommentLogRecord {
  return {
    projectId: 'proj_e',
    name,
    comments: [],
    resolutions: [],
    hidden: [],
    ancestors: [],
    ...overrides
  };
}

describe('L08 encrypted comment logs', () => {
  it('parses only a well-formed log of this project', () => {
    const good = log('Ada', {
      comments: [
        {
          commentId: id(1),
          parentId: null,
          anchor,
          text: ' Wall? ',
          createdAt: '2026-11-17T01:00:00.000Z'
        },
        {
          commentId: id(2),
          parentId: id(1),
          anchor: null,
          text: 'Yes',
          createdAt: '2026-11-17T01:01:00.000Z'
        }
      ],
      resolutions: [
        { threadId: id(1), resolved: true, at: '2026-11-17T01:02:00.000Z' }
      ]
    });
    expect(parseCommentLog(good, 'proj_e')?.comments[0]?.text).toBe('Wall?');
    expect(parseCommentLog(good, 'proj_other')).toBeNull();
    for (const bad of [
      { ...good, name: '' },
      { ...good, comments: [{ ...good.comments[0], commentId: 'x' }] },
      // A thread needs a pin, and a reply has none.
      { ...good, comments: [{ ...good.comments[0], anchor: null }] },
      { ...good, comments: [{ ...good.comments[1], anchor }] },
      {
        ...good,
        resolutions: [{ threadId: id(1), resolved: 'yes', at: 'now' }]
      },
      { ...good, hidden: ['nope'] }
    ])
      expect(parseCommentLog(bad, 'proj_e')).toBeNull();
  });

  it('attributes each comment to its log and applies resolutions by author or owner', () => {
    const owner = {
      userId: 'user_owner',
      record: log('Olive', {
        comments: [
          {
            commentId: id(1),
            parentId: null,
            anchor,
            text: 'Owner thread',
            createdAt: '2026-11-17T01:00:00.000Z'
          }
        ]
      })
    };
    const editor = {
      userId: 'user_editor',
      record: log('Ed', {
        comments: [
          {
            commentId: id(2),
            parentId: null,
            anchor,
            text: 'Editor thread',
            createdAt: '2026-11-17T01:01:00.000Z'
          },
          {
            commentId: id(3),
            parentId: id(1),
            anchor: null,
            text: 'Reply',
            createdAt: '2026-11-17T01:02:00.000Z'
          }
        ],
        // Not the author of thread 1, not the owner: ignored.
        resolutions: [
          { threadId: id(1), resolved: true, at: '2026-11-17T01:03:00.000Z' }
        ]
      })
    };
    let merged = mergeCommentLogs([editor, owner], 'user_owner');
    expect(merged.map((c) => [c.text, c.authorName, c.authorUserId])).toEqual([
      ['Owner thread', 'Olive', 'user_owner'],
      ['Editor thread', 'Ed', 'user_editor'],
      ['Reply', 'Ed', 'user_editor']
    ]);
    expect(merged[0]?.resolvedAt).toBeNull();
    // The owner resolves any thread; the latest event wins.
    owner.record.resolutions = [
      { threadId: id(2), resolved: true, at: '2026-11-17T02:00:00.000Z' }
    ];
    editor.record.resolutions = [
      { threadId: id(2), resolved: false, at: '2026-11-17T01:30:00.000Z' }
    ];
    merged = mergeCommentLogs([editor, owner], 'user_owner');
    expect(merged.find((c) => c.commentId === id(2))).toMatchObject({
      resolvedAt: '2026-11-17T02:00:00.000Z',
      resolvedByName: 'Olive'
    });
  });

  it('lets the owner remove a thread with its replies, and ignores a copied id', () => {
    const owner = {
      userId: 'user_owner',
      record: log('Olive', { hidden: [id(2)] })
    };
    const viewer = {
      userId: 'user_viewer',
      record: log('Vi', {
        comments: [
          {
            commentId: id(2),
            parentId: null,
            anchor,
            text: 'Spam',
            createdAt: '2026-11-17T01:00:00.000Z'
          },
          {
            commentId: id(3),
            parentId: id(2),
            anchor: null,
            text: 'More',
            createdAt: '2026-11-17T01:01:00.000Z'
          },
          {
            commentId: id(4),
            parentId: null,
            anchor,
            text: 'Kept',
            createdAt: '2026-11-17T01:02:00.000Z'
          }
        ]
      })
    };
    // Another member's log cannot take over the viewer's comment by copying its id.
    const copier = {
      userId: 'user_copier',
      record: log('Cop', {
        comments: [
          {
            commentId: id(4),
            parentId: null,
            anchor,
            text: 'Forged',
            createdAt: '2026-11-17T01:05:00.000Z'
          }
        ]
      })
    };
    const merged = mergeCommentLogs([viewer, copier, owner], 'user_owner');
    expect(merged.map((c) => [c.text, c.authorName])).toEqual([['Kept', 'Vi']]);
  });
});

describe('commentLogFollows (L08 encrypted comment log ancestry)', () => {
  const h = (n: number) => n.toString(16).padStart(64, '0');
  const chain = (to: number) => Array.from({ length: to }, (_, i) => h(i + 1));

  it('accepts a log that lists every earlier version, the pinned one in its place', () => {
    // Version 4 lists versions 1–3; this browser pinned version 2.
    expect(
      commentLogFollows({ sequence: 2, hash: h(2) }, 4, chain(3), h(3))
    ).toBe('ok');
    expect(commentLogFollows(null, 1, [], null)).toBe('ok');
  });

  it('calls a log that never saw the pinned version a fork', () => {
    // A device served version 1 only wrote its own version 2 (h(20)), then 3.
    expect(
      commentLogFollows({ sequence: 2, hash: h(2) }, 3, [h(1), h(20)], h(20))
    ).toBe('fork');
    // The pinned hash present, but at another position, is still a fork.
    expect(
      commentLogFollows(
        { sequence: 2, hash: h(2) },
        4,
        [h(1), h(20), h(2)],
        h(2)
      )
    ).toBe('fork');
  });

  it('refuses an ancestry that skips versions or names another previous one', () => {
    expect(commentLogFollows(null, 4, [h(1), h(3)], h(3))).toBe('broken');
    expect(commentLogFollows(null, 3, [h(1), h(2)], h(9))).toBe('broken');
  });

  it('checks a long history within its window and says when it cannot', () => {
    const sequence = MAX_COMMENT_LOG_ANCESTORS + 300;
    const window = Array.from({ length: MAX_COMMENT_LOG_ANCESTORS }, (_, i) =>
      h(sequence - MAX_COMMENT_LOG_ANCESTORS + i)
    );
    const previous = window.at(-1)!;
    const inside = sequence - 10;
    expect(
      commentLogFollows(
        { sequence: inside, hash: h(inside) },
        sequence,
        window,
        previous
      )
    ).toBe('ok');
    expect(
      commentLogFollows({ sequence: 5, hash: h(5) }, sequence, window, previous)
    ).toBe('beyond-window');
  });
});
