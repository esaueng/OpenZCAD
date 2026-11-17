import { useState, type FormEvent } from 'react';
import {
  Check,
  MapPin,
  MessageSquare,
  RotateCcw,
  Trash2,
  X
} from 'lucide-react';
import {
  MAX_PROJECT_COMMENT_TEXT,
  type ProjectAccessRole,
  type ProjectComment
} from '@openzcad/shared';

/** A thread and its replies, numbered as its pin is. */
export interface CommentThread {
  number: number;
  comment: ProjectComment;
  replies: ProjectComment[];
}

/** Threads oldest first, each numbered by that order, with their replies. */
export function commentThreads(comments: readonly ProjectComment[]) {
  const threads = comments
    .filter((comment) => comment.parentId === null)
    .map((comment, index) => ({
      number: index + 1,
      comment,
      replies: [] as ProjectComment[]
    }));
  const byId = new Map(
    threads.map((thread) => [thread.comment.commentId, thread])
  );
  for (const comment of comments)
    if (comment.parentId !== null)
      byId.get(comment.parentId)?.replies.push(comment);
  return threads;
}

export interface CommentsPanelProps {
  /** Null while loading. */
  comments: readonly ProjectComment[] | null;
  error: string | null;
  /** Why comments cannot be used on this project, if they cannot. */
  unavailableReason: string | null;
  currentUserId: string | null;
  role: ProjectAccessRole;
  activeId: string | null;
  onSelect(commentId: string | null): void;
  /** True while the next press on the model places a new thread. */
  placing: boolean;
  onStartPlacing(): void;
  onCancelPlacing(): void;
  /** A point picked for a new thread, waiting for its text. */
  hasDraft: boolean;
  onPostThread(text: string): Promise<boolean>;
  onCancelDraft(): void;
  onReply(threadId: string, text: string): Promise<boolean>;
  onResolve(threadId: string, resolved: boolean): void;
  onDelete(commentId: string): void;
  onClose(): void;
}

function when(createdAt: string): string {
  return new Date(createdAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

/** A text box with Post and Cancel; clears itself after a post lands. */
function Composer({
  label,
  submitLabel,
  onSubmit,
  onCancel
}: {
  label: string;
  submitLabel: string;
  onSubmit(text: string): Promise<boolean>;
  onCancel?(): void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const trimmed = text.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || sending) return;
    setSending(true);
    const posted = await onSubmit(trimmed).finally(() => setSending(false));
    if (posted) setText('');
  }
  return (
    <form className="comment-composer" onSubmit={(event) => void submit(event)}>
      <textarea
        aria-label={label}
        value={text}
        maxLength={MAX_PROJECT_COMMENT_TEXT}
        rows={2}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit(event);
          }
        }}
      />
      <span className="comment-composer-actions">
        {onCancel ? (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          type="submit"
          className="primary"
          disabled={!trimmed || sending}
        >
          {submitLabel}
        </button>
      </span>
    </form>
  );
}

/**
 * L08 review comments: threads pinned to points on the model, with replies.
 * Members of every role comment; the author, an editor or the owner resolves
 * a thread, and the author or the owner deletes a comment.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const {
    comments,
    error,
    unavailableReason,
    currentUserId,
    role,
    activeId,
    placing,
    hasDraft
  } = props;
  const [showResolved, setShowResolved] = useState(false);
  const threads = comments ? commentThreads(comments) : [];
  const open = threads.filter((thread) => !thread.comment.resolvedAt);
  const resolved = threads.filter((thread) => thread.comment.resolvedAt);
  const canResolve = (comment: ProjectComment) =>
    role !== 'viewer' || comment.authorUserId === currentUserId;
  const canDelete = (comment: ProjectComment) =>
    role === 'owner' || comment.authorUserId === currentUserId;

  const renderThread = ({ number, comment, replies }: CommentThread) => {
    const active = activeId === comment.commentId;
    return (
      <li
        key={comment.commentId}
        className={`comment-thread${active ? ' is-active' : ''}${comment.resolvedAt ? ' is-resolved' : ''}`}
      >
        <button
          type="button"
          className="comment-thread-head"
          aria-expanded={active}
          onClick={() => props.onSelect(active ? null : comment.commentId)}
        >
          <span className="comment-number" aria-hidden="true">
            {number}
          </span>
          <span className="comment-thread-text">{comment.text}</span>
        </button>
        <p className="comment-meta">
          {comment.authorName} · {when(comment.createdAt)}
          {comment.resolvedAt
            ? ` · Resolved by ${comment.resolvedByName ?? 'a member'}`
            : ''}
        </p>
        {active ? (
          <div className="comment-thread-body">
            {replies.length ? (
              <ul
                className="comment-replies"
                aria-label={`Replies to comment ${number}`}
              >
                {replies.map((reply) => (
                  <li key={reply.commentId} className="comment-reply">
                    <p className="comment-reply-text">{reply.text}</p>
                    <p className="comment-meta">
                      {reply.authorName} · {when(reply.createdAt)}
                      {canDelete(reply) ? (
                        <button
                          type="button"
                          className="comment-action"
                          aria-label={`Delete reply by ${reply.authorName}`}
                          onClick={() => props.onDelete(reply.commentId)}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            ) : null}
            {!comment.resolvedAt ? (
              <Composer
                label={`Reply to comment ${number}`}
                submitLabel="Reply"
                onSubmit={(text) => props.onReply(comment.commentId, text)}
              />
            ) : null}
            <span className="comment-thread-actions">
              {canResolve(comment) ? (
                <button
                  type="button"
                  className="comment-action"
                  onClick={() =>
                    props.onResolve(comment.commentId, !comment.resolvedAt)
                  }
                >
                  {comment.resolvedAt ? (
                    <RotateCcw size={12} aria-hidden="true" />
                  ) : (
                    <Check size={12} aria-hidden="true" />
                  )}
                  {comment.resolvedAt ? 'Reopen' : 'Resolve'}
                </button>
              ) : null}
              {canDelete(comment) ? (
                <button
                  type="button"
                  className="comment-action"
                  aria-label={`Delete comment ${number}`}
                  onClick={() => props.onDelete(comment.commentId)}
                >
                  <Trash2 size={12} aria-hidden="true" />
                  Delete
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <aside className="comments-panel" aria-label="Comments">
      <header className="comments-panel-head">
        <h2>
          <MessageSquare size={14} aria-hidden="true" />
          Comments
          {comments ? (
            <span className="comments-count">{open.length} open</span>
          ) : null}
        </h2>
        <button
          type="button"
          className="comment-action"
          aria-label="Close comments"
          onClick={props.onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      {unavailableReason ? (
        <p className="comments-note">{unavailableReason}</p>
      ) : (
        <>
          {hasDraft ? (
            <Composer
              label="New comment"
              submitLabel="Post"
              onSubmit={props.onPostThread}
              onCancel={props.onCancelDraft}
            />
          ) : placing ? (
            <p className="comments-note" role="status">
              Click a point on the model to pin your comment.{' '}
              <button
                type="button"
                className="comment-action"
                onClick={props.onCancelPlacing}
              >
                Cancel
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="secondary comments-add"
              onClick={props.onStartPlacing}
            >
              <MapPin size={13} aria-hidden="true" />
              Add comment
            </button>
          )}
          {error ? (
            <p className="comments-note" role="alert">
              {error}
            </p>
          ) : null}
          {comments === null ? (
            <p className="comments-note">Loading comments…</p>
          ) : threads.length === 0 ? (
            <p className="comments-note">
              No comments yet. Pin one to a point on the model.
            </p>
          ) : (
            <>
              <ul className="comment-threads" aria-label="Open comments">
                {open.map(renderThread)}
              </ul>
              {resolved.length ? (
                <>
                  <button
                    type="button"
                    className="comment-action"
                    aria-expanded={showResolved}
                    onClick={() => setShowResolved((shown) => !shown)}
                  >
                    {showResolved ? 'Hide' : 'Show'} {resolved.length} resolved
                  </button>
                  {showResolved ? (
                    <ul
                      className="comment-threads"
                      aria-label="Resolved comments"
                    >
                      {resolved.map(renderThread)}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </aside>
  );
}
