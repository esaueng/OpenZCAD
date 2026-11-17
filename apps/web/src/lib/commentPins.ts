import type { ProjectComment } from '@openzcad/shared';
import type { CommentPin } from '../components/ModelViewer';

/**
 * L08: the numbered pins the viewport draws for the threads shown, at their
 * points on the model. Built beside the viewer, which loads on its own, so
 * the workspace's first load carries none of it.
 */
export function commentPinsOf(
  comments: readonly ProjectComment[],
  activeId: string | null
): CommentPin[] {
  return comments
    .filter((comment) => comment.parentId === null)
    .flatMap((comment, index) =>
      comment.anchor
        ? [
            {
              id: comment.commentId,
              label: String(index + 1),
              description: `Comment ${index + 1} by ${comment.authorName}: ${comment.text}`,
              point: {
                x: comment.anchor.point[0],
                y: comment.anchor.point[1],
                z: comment.anchor.point[2]
              },
              resolved: comment.resolvedAt !== null,
              active: comment.commentId === activeId
            }
          ]
        : []
    );
}
