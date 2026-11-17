import { describe, expect, it } from 'vitest';
import {
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
