import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectComment } from '@openzcad/shared';
import {
  CommentsPanel,
  commentThreads,
  type CommentsPanelProps
} from './CommentsPanel';

function comment(
  id: string,
  overrides: Partial<ProjectComment> = {}
): ProjectComment {
  return {
    commentId: id,
    projectId: 'proj_a',
    parentId: null,
    anchor: { point: [0, 0, 0], documentVersion: 1 },
    text: `Text ${id}`,
    authorUserId: 'user_other',
    authorName: 'Grace',
    createdAt: '2026-11-16T10:00:00.000Z',
    resolvedAt: null,
    resolvedByName: null,
    ...overrides
  };
}

function props(
  overrides: Partial<CommentsPanelProps> = {}
): CommentsPanelProps {
  return {
    comments: [],
    error: null,
    unavailableReason: null,
    currentUserId: 'user_me',
    role: 'editor',
    activeId: null,
    onSelect: vi.fn(),
    placing: false,
    onStartPlacing: vi.fn(),
    onCancelPlacing: vi.fn(),
    hasDraft: false,
    onPostThread: vi.fn(async () => true),
    onCancelDraft: vi.fn(),
    onReply: vi.fn(async () => true),
    onResolve: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  };
}

describe('commentThreads', () => {
  it('numbers threads oldest first and gathers their replies', () => {
    const threads = commentThreads([
      comment('a'),
      comment('b'),
      comment('r', { parentId: 'a', anchor: null })
    ]);
    expect(threads.map((thread) => thread.number)).toEqual([1, 2]);
    expect(threads[0]!.replies.map((reply) => reply.commentId)).toEqual(['r']);
  });
});

describe('CommentsPanel', () => {
  it('says why comments are unavailable instead of offering them', () => {
    render(
      <CommentsPanel
        {...props({
          unavailableReason:
            'Comments are not available on encrypted projects yet.'
        })}
      />
    );
    expect(
      screen.getByRole('complementary', { name: 'Comments' })
    ).toHaveTextContent('not available on encrypted projects');
    expect(screen.queryByRole('button', { name: 'Add comment' })).toBeNull();
  });

  it('places, writes and posts a new thread', async () => {
    const user = userEvent.setup();
    const onStartPlacing = vi.fn();
    const { rerender } = render(
      <CommentsPanel {...props({ onStartPlacing })} />
    );
    expect(screen.getByText(/No comments yet/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(onStartPlacing).toHaveBeenCalled();
    rerender(<CommentsPanel {...props({ placing: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Click a point on the model'
    );
    const onPostThread = vi.fn(async () => true);
    rerender(<CommentsPanel {...props({ hasDraft: true, onPostThread })} />);
    await user.type(
      screen.getByRole('textbox', { name: 'New comment' }),
      'Thicken this rib'
    );
    await user.click(screen.getByRole('button', { name: 'Post' }));
    expect(onPostThread).toHaveBeenCalledWith('Thicken this rib');
  });

  it('opens a thread to reply, resolve and delete by role', async () => {
    const user = userEvent.setup();
    const mine = comment('a', { authorUserId: 'user_me', authorName: 'Me' });
    const theirs = comment('b');
    const reply = comment('r', { parentId: 'b', anchor: null, text: 'Done' });
    const onReply = vi.fn(async () => true);
    const onResolve = vi.fn();
    const base = { comments: [mine, theirs, reply], onReply, onResolve };
    const { rerender } = render(
      <CommentsPanel {...props({ ...base, role: 'viewer', activeId: 'b' })} />
    );
    const open = screen.getByRole('list', { name: 'Open comments' });
    const thread = within(open).getAllByRole('listitem')[1]!;
    expect(
      within(thread).getByRole('list', { name: 'Replies to comment 2' })
    ).toHaveTextContent('Done');
    // A viewer resolves and deletes only their own.
    expect(
      within(thread).queryByRole('button', { name: 'Resolve' })
    ).toBeNull();
    expect(
      within(thread).queryByRole('button', { name: 'Delete comment 2' })
    ).toBeNull();
    await user.type(
      within(thread).getByRole('textbox', { name: 'Reply to comment 2' }),
      'Thanks'
    );
    await user.click(within(thread).getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalledWith('b', 'Thanks');
    rerender(
      <CommentsPanel {...props({ ...base, role: 'editor', activeId: 'b' })} />
    );
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith('b', true);
    // Resolved threads fold away under their count.
    rerender(
      <CommentsPanel
        {...props({
          ...base,
          comments: [
            mine,
            {
              ...theirs,
              resolvedAt: '2026-11-16T11:00:00.000Z',
              resolvedByName: 'Ed'
            },
            reply
          ]
        })}
      />
    );
    expect(screen.getByText('1 open')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 1 resolved' }));
    expect(
      screen.getByRole('list', { name: 'Resolved comments' })
    ).toHaveTextContent('Resolved by Ed');
  });
});
