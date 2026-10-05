import { useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  ConflictResolution,
  ConflictSource,
  ProjectConflict
} from '../lib/conflictRecovery';
import { useModalFocus } from '../lib/useModalFocus';

export interface ProjectConflictDialogProps {
  conflict: ProjectConflict;
  busy: boolean;
  /**
   * Why keeping this device's version is not on offer — a viewer, or a room
   * that demands an edit lease this client does not hold. Null offers it.
   */
  keepMineDisabledReason?: string | null;
  onResolve(resolution: ConflictResolution): void | Promise<void>;
  onClose(): void;
}

/** How the other copy is named, by who raised the conflict. */
const OTHER_SIDE: Record<
  ConflictSource,
  { where: string; use: string; copyThenUse: string }
> = {
  account: {
    where: 'in your account',
    use: 'Use my account’s version',
    copyThenUse: 'Save mine as a copy, then use the account’s'
  },
  room: {
    where: 'in the live session',
    use: 'Use the live version',
    copyThenUse: 'Save mine as a copy, then use the live version'
  }
};

/**
 * The choice between this device's copy of a project and the other one —
 * the account's, or the live session's. One dialog for both sources: the
 * resolutions are the same three, and two dialogs citing the same project
 * from different remotes read as contradicting each other.
 *
 * Deliberately separate from the sharing dialog. That one is about who else
 * can see a project, and it is gated behind a rollout flag; this one has to
 * work with sharing off, which is when a two-device divergence is most
 * likely to go unnoticed.
 *
 * Closing without choosing is allowed. The divergence is recorded, both
 * documents still exist, and forcing a decision at the moment of interruption
 * is how people pick the wrong one.
 */
export function ProjectConflictDialog({
  conflict,
  busy,
  keepMineDisabledReason = null,
  onResolve,
  onClose
}: ProjectConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = busy || resolving;
  useModalFocus(dialogRef, { autoFocus: true });
  const other = OTHER_SIDE[conflict.source];

  async function resolve(resolution: ConflictResolution) {
    setError(null);
    setResolving(true);
    try {
      await onResolve(resolution);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not resolve the conflict. Please retry.'
      );
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-conflict-title"
        aria-busy={working}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!working) onClose();
          }
        }}
      >
        <h2 id="project-conflict-title">
          <TriangleAlert size={16} aria-hidden="true" />
          This project changed in two places
        </h2>
        <p>
          <strong>{conflict.localDocument.name}</strong> is at version{' '}
          {conflict.localDocument.version} on this device and version{' '}
          {conflict.remoteDocument.version} {other.where}. Both still exist —
          whichever you do not keep is saved as a separate recovery project
          first.
        </p>
        <div className="conflict-dialog-actions">
          <button
            type="button"
            disabled={working || keepMineDisabledReason !== null}
            aria-describedby={
              keepMineDisabledReason !== null
                ? 'project-conflict-keep-mine-note'
                : undefined
            }
            onClick={() => void resolve('keep-mine')}
          >
            Keep this device’s version
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void resolve('use-remote')}
          >
            {other.use}
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => void resolve('save-local-copy')}
          >
            {other.copyThenUse}
          </button>
        </div>
        {working && (
          <p className="conflict-dialog-note" role="status">
            Preserving both versions and waiting for confirmation…
          </p>
        )}
        {error && (
          <p className="conflict-dialog-note" role="alert">
            {error}
          </p>
        )}
        {keepMineDisabledReason !== null && (
          <p
            id="project-conflict-keep-mine-note"
            className="conflict-dialog-note"
          >
            {keepMineDisabledReason}
          </p>
        )}
        <button
          type="button"
          className="secondary"
          disabled={working}
          onClick={onClose}
        >
          Decide later
        </button>
      </div>
    </div>
  );
}
