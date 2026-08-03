import { useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import type {
  ConflictResolution,
  ProjectConflict
} from '../lib/conflictRecovery';
import { useModalFocus } from '../lib/useModalFocus';

export interface ProjectConflictDialogProps {
  conflict: ProjectConflict;
  busy: boolean;
  onResolve(resolution: ConflictResolution): void;
  onClose(): void;
}

/**
 * The choice between this device's copy of a project and the account's.
 *
 * Deliberately separate from the sharing dialog. That one is about who else can
 * see a project, and it is gated behind a rollout flag; this one has to work
 * with sharing off, which is when a two-device divergence is most likely to go
 * unnoticed.
 *
 * Closing without choosing is allowed. The divergence is recorded, both
 * documents still exist, and forcing a decision at the moment of interruption
 * is how people pick the wrong one.
 */
export function ProjectConflictDialog({
  conflict,
  busy,
  onResolve,
  onClose
}: ProjectConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { autoFocus: true });

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        className="conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-conflict-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
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
          {conflict.remoteDocument.version} in your account. Both still exist —
          whichever you do not keep is saved as a separate recovery project
          first.
        </p>
        <div className="conflict-dialog-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve('keep-mine')}
          >
            Keep this device’s version
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve('use-remote')}
          >
            Use my account’s version
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onResolve('save-local-copy')}
          >
            Save mine as a copy, then use the account’s
          </button>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          Decide later
        </button>
      </div>
    </div>
  );
}
